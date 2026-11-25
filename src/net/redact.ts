/** Query parameters that may carry a credential. */
const SECRET_PARAMETER = /([?&](?:key|api_key|apikey|token|access_token|auth|signature|sig|x-amz-signature|x-amz-credential|x-goog-signature|x-goog-credential|password|secret)=)[^&#\s]*/gi;
/** The user and password part of a URL (https://user:pass@host/). */
const USERINFO = /(\bhttps?:\/\/)[^/?#@\s]*@/gi;
const REDACTED = '[redacted]';
const MIN_SECRET_LENGTH = 4;

/** Removes every known secret, and any credential-looking query parameter, from text bound for a log or the output. */
export function redact(text: string, secrets: readonly string[]): string {
  let redacted = text.replace(SECRET_PARAMETER, `$1${REDACTED}`).replace(USERINFO, `$1${REDACTED}@`);
  for (const secret of secrets) {
    if (secret.length >= MIN_SECRET_LENGTH) {
      redacted = redacted.split(secret).join(REDACTED);
    }
  }
  return redacted;
}
