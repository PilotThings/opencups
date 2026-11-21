// Router / gateway EUI normalisation.
//
// Basics Station reports its id in "id6" notation (IPv6-like, 4 groups of
// 16-bit hex, with "::" compression), e.g. "b827:ebff:fe61:51b5" or "::1".
// Operators usually type the EUI-64 as "B8-27-EB-FF-FE-61-51-B5".
// Everything is normalised to 16 upper-case hex digits.

const HEX16 = /^[0-9a-f]{16}$/i;
const EUI_SEP = /^[0-9a-f]{2}([-:])[0-9a-f]{2}(\1[0-9a-f]{2}){6}$/i;
const ID6 = /^[0-9a-f:]+$/i;

export function normalizeEui(input) {
  if (typeof input === 'number' && Number.isInteger(input) && input >= 0) {
    return BigInt(input).toString(16).padStart(16, '0').toUpperCase();
  }
  if (typeof input !== 'string') throw new Error('EUI must be a string');
  const s = input.trim();
  if (HEX16.test(s)) return s.toUpperCase();
  if (EUI_SEP.test(s)) return s.replace(/[-:]/g, '').toUpperCase();
  if (/^0x[0-9a-f]{1,16}$/i.test(s)) return s.slice(2).padStart(16, '0').toUpperCase();
  if (/^\d+$/.test(s)) {
    const n = BigInt(s);
    if (n > 0xffffffffffffffffn) throw new Error(`EUI out of range: ${input}`);
    return n.toString(16).padStart(16, '0').toUpperCase();
  }
  if (ID6.test(s) && s.includes(':')) return parseId6(s);
  throw new Error(`Illegal EUI: ${input}`);
}

function parseId6(s) {
  const halves = s.split('::');
  if (halves.length > 2) throw new Error(`Illegal id6: ${s}`);
  const groups = (part) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (halves.length === 1 && head.length !== 4) throw new Error(`Illegal id6: ${s}`);
  const fill = 4 - head.length - tail.length;
  if (fill < 0 || (halves.length === 2 && fill < 1)) throw new Error(`Illegal id6: ${s}`);
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) throw new Error(`Illegal id6: ${s}`);
  return all.map((g) => g.padStart(4, '0')).join('').toUpperCase();
}

/** "B827EBFFFE6151B5" -> "B8-27-EB-FF-FE-61-51-B5" */
export const formatEui = (eui) => eui.match(/../g).join('-');

/** "B827EBFFFE6151B5" -> "b827:ebff:fe61:51b5" (station id6, uncompressed) */
export const formatId6 = (eui) => eui.toLowerCase().match(/..../g).join(':');
