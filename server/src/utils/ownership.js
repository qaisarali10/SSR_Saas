/**
 * Ownership and access control utilities.
 * Centralizes all ownership logic for the multi-tenant SaaS.
 */

// The built-in (non-Supabase) administrator authenticates via the `ssr_admin`
// cookie and has no row in auth.users, so it cannot own a `user_id uuid`
// column. Rows it creates are attributed to this fixed, well-known id instead
// (a nil-ish uuid, guaranteed never to collide with a real auth.users id).
export const BUILT_IN_ADMIN_ID = "00000000-0000-0000-0000-000000000000";

/**
 * Check if user has admin role
 * @param {Object} user - User object from req.user
 * @returns {Boolean} True if user is admin
 */
export function isAdmin(user) {
  return Boolean(user && user.role === "admin");
}

/**
 * Build a Supabase filter for the caller: `{}` for an admin (no filter = all
 * data), otherwise the plain owner filter for a regular user.
 *
 * Prefer scope() over using this directly. PostgREST's `or` cannot be
 * expressed through postgrest-js's .match(): match() turns an array value into
 * one `eq` per element (AND, not OR), so passing `{ or: [...] }` produces
 * `or=eq.[object Object],eq.[object Object]` and Postgres answers "failed to
 * parse logic tree". scope() calls the builder's real .or() instead.
 * @param {Object} user - User object from req.user
 * @returns {Object} filter to apply with `.match()`, or {} for admin
 */
export function buildUserFilter(user) {
  if (!user || isAdmin(user)) return {};
  return { user_id: getUserId(user) };
}

/**
 * The PostgREST `or` expression matching "the caller's own rows, plus the
 * shared ones". A NULL `user_id` means shared: every signed-in user can see it.
 * That is how the migrated legacy catalogue (530 distributors, 2 companies,
 * none of which ever recorded an owner) stays visible to a brand-new account
 * instead of showing an empty workspace. Rows a user creates keep their owner,
 * so per-tenant isolation is unchanged.
 * @param {Object} user - User object from req.user
 * @returns {string} PostgREST or-filter expression
 */
export function ownerOrExpression(user) {
  return `user_id.eq.${getUserId(user)},user_id.is.null`;
}

/**
 * Apply caller scoping to a PostgREST query builder.
 *
 * Other filters already on the builder are ANDed with this by PostgREST, so
 * `.eq("year", 2020)` combined with scope() still means "year 2020 AND
 * (mine OR shared)".
 * @param {Object} query - A supabase-js PostgrestFilterBuilder
 * @param {Object} user - User object from req.user
 * @returns {Object} the same builder, scoped
 */
export function scope(query, user) {
  if (!user || isAdmin(user)) return query;
  return query.or(ownerOrExpression(user));
}

/**
 * Get the uuid to store in `user_id` for create operations. Returns the
 * user's own id for both admin and regular users; the built-in admin's
 * synthetic id is not a real auth.users uuid, so it is mapped to a fixed
 * constant instead.
 * @param {Object} user - User object from req.user
 * @returns {string} uuid
 */
export function getUserId(user) {
  if (!user) return null;
  const value = String(user._id || user.id || "");
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)) {
    return value;
  }
  return BUILT_IN_ADMIN_ID;
}

/**
 * Verify ownership of a resource
 * Admin can access everything
 * Regular users can access their own resources, plus any shared (NULL owner) one
 * @param {Object} user - User object from req.user
 * @param {Object} resource - Resource row from the store (camelCase `userId` or raw `user_id`)
 * @returns {Boolean} True if user owns the resource, is admin, or the resource is shared
 */
export function verifyOwnership(user, resource) {
  if (isAdmin(user)) return true;
  if (!resource) return false;

  const owner = resource.userId ?? resource.user_id;
  // An explicit NULL owner means the row is shared reference data (see
  // buildUserFilter). An *absent* field is not the same thing: it means the
  // owner was never populated, so we cannot tell shared from orphaned and must
  // not hand out access on a guess.
  if (owner === null || owner === "") return true;
  if (owner === undefined) return false;

  return String(owner) === String(getUserId(user));
}

/**
 * Check if user can access a resource
 * @param {Object} user - User object from req.user
 * @param {Object} resource - Resource row from the store
 * @returns {Boolean} True if user can access
 */
export function canAccess(user, resource) {
  return verifyOwnership(user, resource);
}

/**
 * Check if user can modify a resource
 * @param {Object} user - User object from req.user
 * @param {Object} resource - Resource row from the store
 * @returns {Boolean} True if user can modify
 */
export function canModify(user, resource) {
  return verifyOwnership(user, resource);
}

/**
 * Auto-assign user to resource data on create
 * @param {Object} user - User object from req.user
 * @param {Object} data - Resource data
 * @returns {Object} Data with user_id field added
 */
export function assignOwnership(user, data) {
  return {
    ...data,
    user_id: getUserId(user)
  };
}

/**
 * Validate that user has access to resource
 * Throws error if access denied
 * @param {Object} user - User object from req.user
 * @param {Object} resource - Resource row from the store
 * @param {String} resourceName - Name of resource for error message
 * @throws {Error} 403 if access denied
 */
export function validateAccess(user, resource, resourceName = "resource") {
  if (!canAccess(user, resource)) {
    throw new Error(`Access denied: You do not own this ${resourceName}`);
  }
}

/**
 * Validate that user can modify resource
 * Throws error if cannot modify
 * @param {Object} user - User object from req.user
 * @param {Object} resource - Resource row from the store
 * @param {String} resourceName - Name of resource for error message
 * @throws {Error} 403 if cannot modify
 */
export function validateModification(user, resource, resourceName = "resource") {
  if (!canModify(user, resource)) {
    throw new Error(`Access denied: You cannot modify this ${resourceName}`);
  }
}
