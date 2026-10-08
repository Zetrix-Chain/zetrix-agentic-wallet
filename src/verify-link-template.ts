/**
 * The rules MYID_VERIFY_LINK_TEMPLATE has to meet, shared by the config loader (which warns at startup)
 * and create_verification_qr (which refuses to build a link from a template that breaks them).
 *
 * The template is set by the operator, never by the agent or a caller, so these guard against misconfiguration
 * rather than attack. They matter because the reference id is a handle to a stored presentation, and the link
 * is put in front of a person: a link must not run a script, travel in cleartext, or send the id out through
 * DNS by sitting in the host name.
 *
 * The check parses the URL the way a browser will, rather than splitting the string: the URL parser ends the
 * host at a backslash and drops tabs and newlines, so a string split sees the placeholder in the path while
 * the link that is built opens at <id>.example.com.
 */

export const LINK_PLACEHOLDER = '{referenceId}'
export const LINK_TEMPLATE_ENV = 'MYID_VERIFY_LINK_TEMPLATE'

const SCHEME = 'https://'
/** Stands in for the placeholder while the template is parsed, so we can see where it lands. */
const MARKER = 'refidmarker'

/** Why `template` cannot be used, or `null` when it can. */
export function checkVerifyLinkTemplate(template: string | undefined): string | null {
  if (template === undefined || template.trim() === '') {
    return `${LINK_TEMPLATE_ENV} is not set — MyID has to supply the link the reference id goes into.`
  }
  if (!template.includes(LINK_PLACEHOLDER)) {
    return `${LINK_TEMPLATE_ENV} must contain the placeholder ${LINK_PLACEHOLDER}, got "${template}".`
  }
  // Only printable ASCII, and no backslash. A URL parser reads anything else as part of the address — a backslash
  // ends the host, tabs and newlines vanish, and a combining mark after the placeholder changes how the host is
  // normalised — so the string we judge and the link the browser opens could differ. A MyID domain that is not
  // ASCII can be given in its punycode form.
  if (/[^!-~]|[\\]/.test(template)) {
    return `${LINK_TEMPLATE_ENV} must use only printable ASCII characters, with no backslash, space or control character, got ${JSON.stringify(template)}.`
  }
  // The marker stands in for the placeholder below; a template that already contains it would confuse that check.
  if (template.includes(MARKER)) {
    return `${LINK_TEMPLATE_ENV} must not contain the text "${MARKER}", got "${template}".`
  }
  if (!template.startsWith(SCHEME)) {
    return `${LINK_TEMPLATE_ENV} must be an https:// link (for example ${SCHEME}<MyID link domain>/<path>?referenceId=${LINK_PLACEHOLDER}), got "${template}".`
  }
  // 'https:///x' parses as host 'x', which would hide a missing host.
  if (/^https:\/\/[/?#]/.test(template)) {
    return `${LINK_TEMPLATE_ENV} has no host, got "${template}".`
  }
  // Any '@' before the path is user info, even an empty one ('https://@host/'), which the URL parser drops silently.
  if (/^https:\/\/[^/?#]*@/.test(template)) {
    return `${LINK_TEMPLATE_ENV} must not carry user info (an @ before the host), got "${template}".`
  }

  let url: URL
  try {
    url = new URL(template.split(LINK_PLACEHOLDER).join(MARKER))
  } catch {
    return `${LINK_TEMPLATE_ENV} must be an absolute https URL, got "${template}".`
  }
  if (url.protocol !== 'https:' || url.hostname === '') {
    return `${LINK_TEMPLATE_ENV} must be an absolute https URL with a host, got "${template}".`
  }
  if (url.username !== '' || url.password !== '') {
    return `${LINK_TEMPLATE_ENV} must not carry user info (name:password@host), got "${template}".`
  }
  if (url.host.includes(MARKER)) {
    return `${LINK_TEMPLATE_ENV} must not put ${LINK_PLACEHOLDER} in the host: the reference id would be sent out in a DNS lookup.`
  }
  // A fragment never reaches the server, so an id placed only there is not what MyID's universal link reads.
  if (!(url.pathname + url.search).includes(MARKER)) {
    return `${LINK_TEMPLATE_ENV} must put ${LINK_PLACEHOLDER} in the path or the query, not only after a #.`
  }
  return null
}
