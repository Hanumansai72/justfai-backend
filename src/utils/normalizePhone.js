// Local 10-digit numbers use India's country code; international numbers keep
// their explicit country code. Formatting cannot bypass a reserved number.
module.exports = value => {
  if (value == null || value === '') return undefined;
  let digits = String(value).trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);
  if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  if (/^\d{10}$/.test(digits)) return '+91' + digits;
  return '+' + digits.replace(/\+/g, '');
};
