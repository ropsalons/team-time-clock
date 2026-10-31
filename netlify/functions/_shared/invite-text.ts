// Invite message text, English + Spanish. Some Team staff read Spanish more
// comfortably, so admins can choose the language per person when they send.
// On-screen app labels (e.g. "Phone + PIN", "First time here? Set up your PIN",
// "Help") are kept in English inside BOTH messages, because that's exactly what
// the person will see on the screen — translating them would cause confusion.
// Spanish is written for the (female) staff being onboarded and uses proper
// accents (this makes the SMS a Unicode message = a few more segments, which is
// fine for an invite).

export type Lang = 'en' | 'es';
export const asLang = (v: unknown): Lang => (v === 'es' ? 'es' : 'en');

export function inviteSmsText(firstName: string, appUrl: string, lang: Lang): string {
  if (lang === 'es') {
    return (
      `Hola ${firstName}, somos Sample Salon Co. Usamos nuestro propio reloj de tiempo, Team Time Clock, y ya estás registrada.\n\n` +
      `Empieza hoy: abre ${appUrl}, déjalo en "Phone + PIN", toca "First time here? Set up your PIN", escribe este número de celular y elige un PIN de 4 dígitos. Ese es tu acceso.\n\n` +
      `¿Olvidaste marcar, o hay que corregir una hora? Toca el enlace al final de la pantalla y envíalo; nos llega directo, sin tener que buscar a nadie.\n\n` +
      `Consejo: agrégalo a tu pantalla de inicio para que se abra como una app. iPhone: abre el enlace en Safari, toca Compartir y luego "Add to Home Screen". Android: ábrelo en Chrome, toca el menú de 3 puntos y luego "Add to Home screen". (Toca "Help" en la app para ver imágenes.)\n\n` +
      `Responde SÍ para confirmar que lo recibiste y ya estás lista. Cualquier problema, avísanos.`
    );
  }
  return (
    `Hi ${firstName}, it's Sample Salon Co. We use our own time clock, Team Time Clock - and you're set up now.\n\n` +
    `Start today: open ${appUrl}, keep it on "Phone + PIN", tap "First time here? Set up your PIN", enter this mobile number, and pick a 4-digit PIN. That's your login.\n\n` +
    `Forgot to punch, or need one added or fixed? Tap the link at the bottom of the screen and submit it - it comes straight to us, no more chasing anyone down.\n\n` +
    `Tip: add it to your home screen so it opens like an app. iPhone: open the link in Safari, tap Share, then "Add to Home Screen." Android: open in Chrome, tap the 3-dot menu, then "Add to Home screen." (Tap Help in the app for pictures.)\n\n` +
    `Reply YES to confirm you got this and you're set up. Any problems, just let us know.`
  );
}

export function inviteEmailSubject(lang: Lang): string {
  return lang === 'es'
    ? 'Ya estás registrada en Team Time Clock — nuestro nuevo reloj de tiempo'
    : "You're set up on Team Time Clock — our new time clock";
}

export function inviteEmailText(firstName: string, appUrl: string, lang: Lang): string {
  if (lang === 'es') {
    return (
      `Hola ${firstName},\n\n` +
      `Usamos nuestro propio reloj de tiempo, Team Time Clock, y ya estás registrada.\n\n` +
      `Empieza hoy: abre ${appUrl}, déjalo en "Phone + PIN", toca "First time here? Set up your PIN", escribe tu número de celular y elige un PIN de 4 dígitos. Ese es tu acceso. (Si prefieres, también puedes entrar con este correo.)\n\n` +
      `¿Olvidaste marcar, o hay que agregar o corregir una hora? Solo toca el enlace al final de la pantalla y envíalo; nos llega directo, sin tener que buscar a nadie.\n\n` +
      `AGRÉGALO A TU PANTALLA DE INICIO para que se abra como una app:\n` +
      `• iPhone: abre ${appUrl} en Safari, toca el botón Compartir (el cuadro con la flecha hacia arriba), luego "Add to Home Screen" y luego Add.\n` +
      `• Android: abre ${appUrl} en Chrome, toca el menú ⋮ (arriba a la derecha), luego "Add to Home screen" (o "Install app").\n` +
      `(Ya adentro, toca "Help" en la app para ver imágenes paso a paso.)\n\n` +
      `Respóndenos para avisar que lo recibiste y ya estás lista. Cualquier problema, avísanos.\n\n— Sample Salon Co`
    );
  }
  return (
    `Hi ${firstName},\n\n` +
    `We use our own time clock, Team Time Clock — and you're set up now.\n\n` +
    `Start today: open ${appUrl}, keep it on "Phone + PIN", tap "First time here? Set up your PIN", enter your mobile number, and pick a 4-digit PIN. That's your login. (You can also sign in with this email if you prefer.)\n\n` +
    `Forgot to punch, or need one added or fixed? Just tap the link at the bottom of the screen and submit it — it comes straight to us, no more tracking someone down.\n\n` +
    `ADD IT TO YOUR HOME SCREEN so it opens like an app:\n` +
    `• iPhone: open ${appUrl} in Safari, tap the Share button (square with an up-arrow), then "Add to Home Screen," then Add.\n` +
    `• Android: open ${appUrl} in Chrome, tap the ⋮ menu (top-right), then "Add to Home screen" (or "Install app").\n` +
    `(Once you're in, tap "Help" in the app for step-by-step pictures.)\n\n` +
    `Reply to let us know you got this and you're set up. Any problems, just let us know.\n\n— Sample Salon Co`
  );
}
