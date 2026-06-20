/* ============================================================================
 * OOTP rebuild — TRUSTED-SCORE CAPTURE (paste-safe one-liner)
 * ----------------------------------------------------------------------------
 * Exports one tournament's scoring environment from the OLD app so the rebuild
 * can be validated against the scores you trust (the Roster & Lineup page's
 * calibrated scores).
 *
 * HOW TO USE (repeat once per tournament):
 *   1. Old app → Roster & Lineup page → select the tournament → click Generate
 *      once (this computes the calibration scales).
 *   2. DevTools (F12) → Console.
 *   3. Paste the ONE line below, press Enter. It copies a JSON blob to your
 *      clipboard.
 *   4. Paste that blob to the rebuild author (chat) — the capture file is built
 *      from it. (No file download / no renaming needed.)
 *
 * Single expression → cannot throw "return not in function".
 * ========================================================================== */

copy(JSON.stringify({coeffs:localStorage.getItem('ootp_coeffs_v2'),calScales:localStorage.getItem('ootp.calibrationScales')}))

/* If copy() isn't available in your console, run this instead, then right-click
 * the printed string → Copy:
 *
 *   JSON.stringify({coeffs:localStorage.getItem('ootp_coeffs_v2'),calScales:localStorage.getItem('ootp.calibrationScales')})
 */
