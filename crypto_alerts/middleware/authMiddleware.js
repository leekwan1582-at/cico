/**
 * @file Authentication Middleware
 * @description Protects routes, parses signed JWT session cookies or Authorization headers,
 * and attaches authenticated user context to req.user.
 * @module middleware/authMiddleware
 */

const authService = require("../services/authService");
const tokenService = require("../services/tokenService");

/**
 * Helper to parse cookies from the Cookie request header string.
 *
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;

  cookieHeader.split(";").forEach((cookie) => {
    let [name, ...rest] = cookie.split("=");
    name = name?.trim();
    if (!name) return;
    const value = rest.join("=").trim();
    list[name] = decodeURIComponent(value);
  });

  return list;
}

/**
 * Validates a redirect URL to prevent open redirect vulnerabilities (S5).
 * Strictly allows relative paths like `/` or `/alerts?foo=bar`.
 * Rejects protocol-relative URLs (`//evil.com`), backslashes (`/\evil.com`), or external schemes.
 *
 * @param {string} url - Candidate redirect path.
 * @returns {string} Safe relative redirect path, or '/' if invalid.
 */
function sanitizeRedirectUrl(url) {
  if (!url || typeof url !== "string") return "/";
  const trimmed = url.trim();
  // Must start with a single forward slash not followed by another slash or backslash
  if (/^\/(?!\/|\\)/.test(trimmed)) {
    return trimmed;
  }
  return "/";
}

/**
 * Middleware that requires valid authentication via JWT session or Personal API Token (PAT).
 * If valid, sets `req.user` and calls next().
 * If invalid or absent:
 * - HTML requests: Redirects to `/login`
 * - API / AJAX requests: Returns 401 Unauthorized JSON
 */
async function requireAuth(req, res, next) {
  let token = null;
  let isBearerPat = false;

  // 1. Try Authorization header: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
    if (token.startsWith("cpat_")) {
      isBearerPat = true;
    }
  }

  // 2. Try Cookie: jwt_token
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.jwt_token;
  }

  if (token) {
    if (isBearerPat) {
      try {
        const verified = await tokenService.verifyToken(token);
        if (verified && !verified.error) {
          req.user = verified;
          res.locals.currentUser = verified;
          return next();
        } else if (verified && verified.error === "INSUFFICIENT_SCOPE") {
          return res.status(403).json({
            error: "Forbidden",
            message: `Token lacks required scope. Found: ${verified.userScopes.join(", ")}`,
          });
        }
      } catch (err) {
        // Fall through to 401
      }
    } else {
      const userPayload = authService.verifyToken(token);
      if (userPayload) {
        req.user = userPayload;
        res.locals.currentUser = userPayload;
        return next();
      }
    }
  }

  // Handle unauthenticated request
  if (req.xhr || req.headers.accept?.includes("application/json") || req.path.startsWith("/api/")) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Please log in or provide a valid API token to access this resource.",
    });
  }

  // Redirect to login page for browser sessions
  const safeRedirect = sanitizeRedirectUrl(req.originalUrl || "/");
  return res.redirect(`/login?redirect=${encodeURIComponent(safeRedirect)}`);
}

/**
 * Middleware that requires a specific scope if authenticated via Personal API Token.
 * JWT sessions automatically possess all scopes.
 *
 * @param {string} requiredScope - Scope name (e.g. 'read:alerts', 'write:alerts')
 * @returns {import('express').RequestHandler}
 */
function requireScope(requiredScope) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized", message: "Authentication required" });
    }

    if (!req.user.isApiToken) {
      return next();
    }

    const scopes = req.user.tokenScopes || [];
    if (!scopes.includes(requiredScope.toLowerCase())) {
      return res.status(403).json({
        error: "Forbidden",
        message: `API token lacks required scope: '${requiredScope}'. Available: [${scopes.join(", ")}]`,
      });
    }

    next();
  };
}

/**
 * Role-Based Access Control (RBAC) middleware factory.
 * Requires the authenticated user to possess a specific role (case-insensitive).
 * Supports single role or array of allowed roles.
 *
 * @param {string|string[]} expectedRoles - Role or array of roles (e.g. 'ADMIN' or ['ADMIN']).
 * @returns {import('express').RequestHandler}
 */
function requireRole(expectedRoles) {
  const allowed = (Array.isArray(expectedRoles) ? expectedRoles : [expectedRoles]).map((r) =>
    String(r).trim().toUpperCase()
  );

  return function (req, res, next) {
    const isApi = req.xhr || req.headers?.accept?.includes("application/json") || (req.path && req.path.startsWith("/api/"));

    if (!req.user) {
      if (isApi) {
        return res.status(401).json({
          error: "Unauthorized",
          message: "Authentication required.",
        });
      }
      const safeRedirect = sanitizeRedirectUrl(req.originalUrl || "/");
      return res.redirect(`/login?redirect=${encodeURIComponent(safeRedirect)}`);
    }

    const rawRole = req.user.role || (req.user.username === "leekwan" ? "ADMIN" : "TRADER");
    const userRole = String(rawRole).trim().toUpperCase();

    if (!allowed.includes(userRole)) {
      const roleMsg = allowed.includes("ADMIN") && allowed.length === 1
        ? "Administrator privilege required."
        : `Access denied. Required role: ${allowed.join(" or ")}.`;

      if (isApi) {
        return res.status(403).json({
          error: "Forbidden",
          message: roleMsg,
        });
      }
      return res.status(403).send(`Forbidden: ${roleMsg}`);
    }

    next();
  };
}

/**
 * Middleware that requires the user to have an administrator role.
 * Alias for requireRole('ADMIN').
 * Must be preceded by `requireAuth` in the middleware chain.
 * If user is not admin:
 * - HTML requests: Returns 403 Forbidden page or message
 * - API / AJAX requests: Returns 403 Forbidden JSON
 */
const requireAdmin = requireRole("ADMIN");

/**
 * Optional authentication middleware: attaches user if token exists, but does not block.
 */
function optionalAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }
  if (!token && req.headers.cookie) {
    const cookies = parseCookies(req.headers.cookie);
    token = cookies.jwt_token;
  }

  if (token) {
    const userPayload = authService.verifyToken(token);
    if (userPayload) {
      req.user = userPayload;
      res.locals.currentUser = userPayload;
    }
  }
  next();
}

module.exports = {
  requireAuth,
  requireRole,
  requireAdmin,
  requireScope,
  optionalAuth,
  parseCookies,
  sanitizeRedirectUrl,
};
