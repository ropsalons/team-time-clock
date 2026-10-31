import { json, error, readJson, requireMethod } from './_shared/http';
import { normalizePhone, isValidPin, signInPhonePin } from './_shared/pin';

// Staff login by mobile number + 4-digit PIN. Returns Supabase session tokens
// for the client to adopt. Generic error on failure (no account enumeration).

interface Body { phone: string; pin: string }

export default async (req: Request): Promise<Response> => {
  try {
    requireMethod(req, 'POST');
    const { phone, pin } = await readJson<Body>(req);
    const e164 = normalizePhone(phone);
    if (!e164 || !isValidPin(pin)) return error(401, 'bad_credentials', 'Check your phone number and PIN.');

    const tokens = await signInPhonePin(e164, pin);
    if (!tokens) return error(401, 'bad_credentials', 'That phone number or PIN is not right.');
    return json({ ok: true, ...tokens });
  } catch (e) {
    if (e instanceof Response) return e;
    console.error('[otc] login-phone error', e);
    return error(500, 'internal', 'Unexpected error.');
  }
};

export const config = { path: '/api/login-phone' };
