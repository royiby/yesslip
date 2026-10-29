import express from 'express';
import { authorizationUrl, exchangeCode, verifyIdToken, redirectUri } from './google.js';
import {
  newOauthChallenge, issueOauthState, readOauthState, clearOauthState,
  issueSession, clearSession, readSession,
} from './session.js';
import {
  upsertUserFromGoogle, getUserById, sessionIsFresh, signOutEverywhere,
  membershipsFor, roleFor, claimInvitationsByEmail, acceptInvitationByToken,
} from './store.js';
import { log } from '../lib/logger.js';

/**
 * Only a local path is ever followed after login. `returnTo` arrives as a
 * query parameter on /auth/google, so without this check an attacker hands
 * someone a link that signs them in and then lands them on a lookalike site,
 * and our own signature on the state cookie is what makes it look legitimate.
 *
 * Rejecting anything with a scheme or authority is not enough on its own:
 * "//evil.example" is protocol-relative and a browser treats it as a host.
 */
export function safeReturnTo(value, fallback = '/app') {
  const path = String(value ?? '');
  if (!path.startsWith('/')) return fallback;
  if (path.startsWith('//')) return fallback;
  if (path.includes('\\')) return fallback;   // some clients normalise \ to /
  if (/[\r\n]/.test(path)) return fallback;   // header splitting
  return path;
}

/**
 * Identity, re-derived per request. The cookie says who; the database says
 * whether that is still true, which is what makes removing a membership or
 * signing out everywhere take effect immediately.
 */
export async function currentUser(req) {
  const claims = readSession(req);
  if (!claims?.uid) return null;
  const user = await getUserById(claims.uid);
  if (!user) return null;
  if (!sessionIsFresh(user, claims.iat)) return null;
  return user;
}

export function requireUser(req, res, next) {
  currentUser(req).then((user) => {
    if (!user) {
      // An API caller gets JSON; a browser gets sent to sign in. Returning the
      // login HTML to a fetch() is how a session expiry turns into a parse
      // error nobody can read.
      if (req.accepts(['html', 'json']) === 'json') {
        return res.status(401).json({ error: 'צריך להתחבר מחדש', signedOut: true });
      }
      return res.redirect(`/auth/google?returnTo=${encodeURIComponent(req.originalUrl)}`);
    }
    req.user = user;
    return next();
  }).catch(next);
}

/**
 * Resolves which business this request is for and what the user may do in it.
 * Membership is the authorisation, and it is read here rather than trusted
 * from the session.
 */
export function requireTenant({ role = null, param = 'tenantId' } = {}) {
  return (req, res, next) => {
    const tenantId = req.params?.[param] ?? req.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'חסר מזהה עסק' });

    roleFor(req.user.id, tenantId).then((found) => {
      // 404, not 403: confirming a business exists to someone with no access
      // to it is itself a disclosure.
      if (!found) return res.status(404).json({ error: 'לא נמצא' });
      if (role === 'owner' && found !== 'owner') {
        return res.status(403).json({ error: 'הפעולה הזו מותרת לבעלים בלבד' });
      }
      req.tenantId = tenantId;
      req.role = found;
      return next();
    }).catch(next);
  };
}

export function makeAuthRouter() {
  const router = express.Router();

  router.get('/google', (req, res) => {
    const challenge = newOauthChallenge(safeReturnTo(req.query.returnTo));
    res.setHeader('Set-Cookie', issueOauthState(challenge));
    res.redirect(authorizationUrl(challenge));
  });

  router.get('/google/callback', async (req, res, next) => {
    const parked = readOauthState(req);
    const fail = (reason, status = 400) => {
      log.warn('auth.callback_rejected', { reason });
      res.setHeader('Set-Cookie', clearOauthState());
      // Deliberately vague to the user, specific in the log: the reasons are
      // all either our bug or someone probing.
      return res.status(status).send('ההתחברות נכשלה. נסו שוב מהתחלה.');
    };

    // Google reports a refused consent screen this way, which is not an error.
    if (req.query.error) return fail(`google:${req.query.error}`);
    if (!parked) return fail('no_state_cookie');
    if (!req.query.code) return fail('no_code');
    // The state check is the CSRF defence on this endpoint: without it, an
    // attacker's code can be redeemed in the victim's browser.
    if (!req.query.state || req.query.state !== parked.state) return fail('state_mismatch');

    try {
      const tokens = await exchangeCode({
        code: String(req.query.code), verifier: parked.verifier, uri: redirectUri(),
      });
      const identity = await verifyIdToken(tokens.id_token, { nonce: parked.nonce });

      const user = await upsertUserFromGoogle(identity);
      // Claimed here, on a verified email_verified claim from a
      // signature-checked token, so an invited person does not need the link.
      const claimed = await claimInvitationsByEmail(user.id, user.email);

      log.info('auth.signed_in', { userId: user.id, claimed: claimed.length });
      res.setHeader('Set-Cookie', [clearOauthState(), issueSession(user.id)]);

      const memberships = await membershipsFor(user.id);
      // A user with no business goes to onboarding, not to an empty app.
      return res.redirect(memberships.length === 0 ? '/onboarding' : safeReturnTo(parked.returnTo));
    } catch (error) {
      log.warn('auth.callback_failed', { message: error.message });
      if (error.message.includes('id_token') || error.message.includes('verified email')) {
        return fail(`verify:${error.message}`, 401);
      }
      return next(error);
    }
  });

  /**
   * POST, not GET. A GET sign-out can be triggered by any image tag on any
   * page, which is not a security hole so much as an irritating one.
   */
  router.post('/signout', (_req, res) => {
    res.setHeader('Set-Cookie', clearSession());
    res.json({ ok: true });
  });

  router.post('/signout-everywhere', requireUser, async (req, res, next) => {
    try {
      await signOutEverywhere(req.user.id);
      res.setHeader('Set-Cookie', clearSession());
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  /** Who am I, and which businesses can I act for. Drives the app shell. */
  router.get('/me', requireUser, async (req, res, next) => {
    try {
      res.json({
        user: { id: req.user.id, email: req.user.email, name: req.user.name },
        tenants: await membershipsFor(req.user.id),
      });
    } catch (error) { next(error); }
  });

  /**
   * The invitation link. Signing in first is required, because an invitation
   * grants a specific person access and we have to know who redeemed it.
   */
  router.get('/accept/:token', async (req, res, next) => {
    try {
      const user = await currentUser(req);
      if (!user) {
        const back = `/auth/accept/${encodeURIComponent(req.params.token)}`;
        return res.redirect(`/auth/google?returnTo=${encodeURIComponent(back)}`);
      }

      const result = await acceptInvitationByToken(req.params.token, user.id);
      if (!result.accepted) return res.status(400).send(result.problem);

      log.info('auth.invitation_accepted', { userId: user.id, tenantId: result.tenantId });
      return res.redirect('/app');
    } catch (error) { next(error); }
  });

  return router;
}
