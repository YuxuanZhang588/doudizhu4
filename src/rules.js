// Rules + evaluator for 4-player Dou Dizhu (no jokers)
// - 52-card deck (no jokers)
// - 4 players, deal 12 each, 4 bottom
// - Rank order: 4 < 5 < ... < A < 2 (highest)
// - 3 is wildcard (mixed). As a single, 3 is the smallest single (below 4).
// - Straights: length >= 5, cannot include 2. 3 may appear only as wildcard to fill missing ranks.
// - Groups: single/pair/triple, bombs (four of a kind)
// - Plane: consecutive triples (>=2); with wings: each triple can carry one single (wings count == #triples)

// NOTE: This is a PoC evaluator focusing on:
//  - classify selected cards into one of supported types
//  - compare two plays (including bomb trump)
// It does NOT yet enumerate all legal moves from a hand.

export const RANKS = ['4','5','6','7','8','9','10','J','Q','K','A','2','3'];
// We keep 3 at end for convenience, but 3 has special handling.

export function rankValue(r) {
  // Used for comparing normal ranks in sets/straights.
  // 4..A => 4..14, 2 => 15, 3 (as natural) => 1 (lowest single)
  if (r === '3') return 1;
  if (r === '2') return 15;
  if (r === 'A') return 14;
  if (r === 'K') return 13;
  if (r === 'Q') return 12;
  if (r === 'J') return 11;
  return Number(r);
}

export function cmpRank(a, b) {
  return rankValue(a) - rankValue(b);
}

export function makeDeck() {
  // 4 suits x 13 ranks
  const suits = ['S','H','D','C'];
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const s of suits) {
    for (const r of ranks) deck.push({ r, s, id: `${r}${s}${Math.random().toString(16).slice(2,6)}` });
  }
  return deck;
}

export function shuffle(arr, rng=Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function sortHand(cards) {
  return [...cards].sort((a,b) => {
    const dv = rankValue(a.r) - rankValue(b.r);
    if (dv !== 0) return dv;
    return a.s.localeCompare(b.s);
  });
}

function countsByRank(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.r, (m.get(c.r) || 0) + 1);
  return m;
}

function numWild(cards) {
  return cards.filter(c => c.r === '3').length;
}

function ranksNoWild(cards) {
  return cards.filter(c => c.r !== '3').map(c => c.r);
}

function isAllSameRankWithWild(cards, targetRank) {
  // can cards be treated as all targetRank using 3 as wildcard?
  const m = countsByRank(cards);
  const w = m.get('3') || 0;
  const have = m.get(targetRank) || 0;
  return have + w === cards.length;
}

function bestSetRank(cards, setSize) {
  // For pair/triple/quad detection with wilds:
  // find the highest rank (by rankValue) that can be formed.
  // Excludes '3' as natural target (we don't allow creating '3 of 3' beyond using wild? but 3 itself is wildcard; treat target ranks as non-3)
  const m = countsByRank(cards);
  const w = m.get('3') || 0;
  const candidates = [];
  for (const [r, cnt] of m.entries()) {
    if (r === '3') continue;
    if (cnt + w === setSize) candidates.push(r);
  }
  // also allow all-wild forming any rank? If all cards are 3, then set can be any rank; choose highest for comparison.
  if (cards.length === w) {
    for (const r of ['4','5','6','7','8','9','10','J','Q','K','A','2']) candidates.push(r);
  }
  candidates.sort((a,b) => rankValue(a) - rankValue(b));
  return candidates.at(-1) || null;
}

function straightResolve(cards) {
  // Determine if cards can form a straight (>=5) with 3 as wilds.
  // 2 cannot be in straight. 3 cannot be natural in straight; any 3 must map to missing ranks.
  // Return {len, highRank, mappedRanks[]} where highRank is highest rank in straight.
  if (cards.length < 5) return null;

  const w = numWild(cards);
  const rs = ranksNoWild(cards);
  if (rs.includes('2')) return null;

  // Must be all distinct among non-wild ranks.
  const set = new Set(rs);
  if (set.size !== rs.length) return null;

  // Convert to numeric values for 4..A (4..14). Exclude 3.
  const vals = rs.map(rankValue).sort((a,b)=>a-b);
  // 4..14 only.
  if (vals.some(v => v < 4 || v > 14)) return null;

  const n = cards.length;
  // Try all possible straight windows of length n within [4..14]
  // For each window start..start+n-1, check if all nonwild vals are in it and wilds can fill gaps.
  for (let start = 4; start <= 14 - n + 1; start++) {
    const need = new Set();
    for (let v = start; v < start + n; v++) need.add(v);
    let missing = 0;
    for (const v of need) {
      if (!vals.includes(v)) missing++;
    }
    if (missing === w) {
      const mapped = [];
      for (let v = start; v < start + n; v++) mapped.push(v);
      const highV = start + n - 1;
      const highRank = valueToRank(highV);
      return { len: n, highRank, mappedValues: mapped };
    }
  }
  return null;
}

export function valueToRank(v) {
  if (v === 15) return '2';
  if (v === 14) return 'A';
  if (v === 13) return 'K';
  if (v === 12) return 'Q';
  if (v === 11) return 'J';
  return String(v);
}

export function classifyPlay(cards) {
  // cards: array of {r,s}
  const n = cards.length;
  if (n === 0) return { ok: false, reason: 'empty' };

  // Sort for display
  const sorted = sortHand(cards);

  // Bomb (4 of a kind, wilds allowed to make quad)
  if (n === 4) {
    const r = bestSetRank(sorted, 4);
    if (r) {
      // Special display/semantics: 3333 can act as 2222 bomb.
      const allWild = sorted.every(c => c.r === '3');
      if (allWild) return { ok: true, type: 'BOMB', main: '3', mainEffective: '2', size: 4, cards: sorted };
      return { ok: true, type: 'BOMB', main: r, size: 4, cards: sorted };
    }
  }

  // Triple + single (三带一)
  // - 4 cards total
  // - can form a triple using wild 3s, plus one remaining single
  if (n === 4) {
    const m = countsByRank(sorted);
    const w = m.get('3') || 0;

    // Try picking a triple rank (non-3) that can be formed
    const triplePool = ['4','5','6','7','8','9','10','J','Q','K','A','2'];
    let bestTriple = null;
    for (const r of triplePool) {
      const have = m.get(r) || 0;
      const needW = Math.max(0, 3 - have);
      if (needW > w) continue;
      // remaining cards after allocating triple must be exactly 1
      const leftover = 4 - 3;
      if (leftover !== 1) continue;
      if (!bestTriple || rankValue(r) > rankValue(bestTriple)) bestTriple = r;
    }

    if (bestTriple) {
      return { ok: true, type: 'TRIPLE_SINGLE', main: bestTriple, size: 4, cards: sorted };
    }
  }

  // Single
  if (n === 1) {
    const r = sorted[0].r;
    if (r === '3') {
      // Per your rule update: single 3 can act as wildcard up to 2.
      return { ok: true, type: 'SINGLE', main: '3', mainEffective: '2', size: 1, cards: sorted };
    }
    return { ok: true, type: 'SINGLE', main: r, size: 1, cards: sorted };
  }

  // Pair
  if (n === 2) {
    const r = bestSetRank(sorted, 2);
    if (r) return { ok: true, type: 'PAIR', main: r, size: 2, cards: sorted };
    return { ok:false, reason:'not a pair' };
  }

  // Triple
  if (n === 3) {
    const r = bestSetRank(sorted, 3);
    if (r) return { ok: true, type: 'TRIPLE', main: r, size: 3, cards: sorted };
    return { ok:false, reason:'not a triple' };
  }

  // Straight
  const st = straightResolve(sorted);
  if (st) {
    return { ok: true, type: 'STRAIGHT', main: st.highRank, len: st.len, size: n, mappedValues: st.mappedValues, mappedRanks: st.mappedValues.map(valueToRank), cards: sorted };
  }

  // Double dragon (consecutive pairs, len>=3)
  const dd = doubleDragonResolve(sorted);
  if (dd) {
    return { ok: true, type: 'DOUBLE_DRAGON', main: dd.highRank, len: dd.len, size: n, mappedValues: dd.mappedValues, mappedRanks: dd.mappedValues.map(valueToRank), cards: sorted };
  }

  // Plane / plane with wings (PoC: only single wings, not pair wings)
  const plane = classifyPlane(sorted);
  if (plane) return plane;

  return { ok:false, reason:'unsupported/invalid combo (PoC)' };
}

function doubleDragonResolve(cards) {
  // consecutive pairs (>=3), 2 cannot be included, 3 may appear only as wildcard.
  const n = cards.length;
  if (n < 6 || n % 2 !== 0) return null;

  const w = numWild(cards);
  const rs = ranksNoWild(cards);
  if (rs.includes('2')) return null;

  const m = countsByRank(cards);
  // each non-wild rank cannot exceed 2 for a pure consecutive-pairs structure
  for (const [r, cnt] of m.entries()) {
    if (r === '3') continue;
    if (cnt > 2) return null;
    // ranks in double dragon must be 4..A
    const v = rankValue(r);
    if (v < 4 || v > 14) return null;
  }

  const len = n / 2;

  // Try windows of len ranks in [4..14]
  for (let start = 4; start <= 14 - len + 1; start++) {
    let missing = 0;
    const mapped = [];
    for (let v = start; v < start + len; v++) {
      mapped.push(v);
      const r = valueToRank(v);
      const have = m.get(r) || 0;
      if (have < 2) missing += (2 - have);
    }
    // nonwild ranks must be subset of window (already by count check), but ensure no extra ranks outside window
    const windowSet = new Set(mapped.map(valueToRank));
    for (const r of rs) {
      if (!windowSet.has(r)) {
        missing = Infinity;
        break;
      }
    }

    if (missing === w) {
      const highV = start + len - 1;
      return { len, highRank: valueToRank(highV), mappedValues: mapped };
    }
  }

  return null;
}

function classifyPlane(cards) {
  // User rule override (2026-02-20): plane-with-wings does NOT require triple groups to be consecutive.
  // Need k>=2 triple groups (each 3-of-a-kind using '3' as wild). Triple ranks may include '2'.
  // If wings present: only single wings; wing count == k.
  const n = cards.length;
  if (n < 6) return null;
  const m0 = countsByRank(cards);
  const w0 = m0.get('3') || 0;

  const possibleK = [];
  for (let k = 2; k <= 8; k++) {
    if (n === 3 * k || n === 4 * k) possibleK.push(k);
  }
  if (possibleK.length === 0) return null;

  const tripleRankPool = ['4','5','6','7','8','9','10','J','Q','K','A','2'];

  // helper: combinations of array indices (small sizes only)
  function* comb(arr, k, start=0, picked=[]) {
    if (picked.length === k) { yield picked.slice(); return; }
    for (let i = start; i <= arr.length - (k - picked.length); i++) {
      picked.push(arr[i]);
      yield* comb(arr, k, i + 1, picked);
      picked.pop();
    }
  }

  let best = null;
  for (const k of possibleK) {
    const hasWings = (n === 4 * k);
    const wingsNeeded = hasWings ? k : 0;

    for (const ranks of comb(tripleRankPool, k)) {
      // compute wild need
      let needW = 0;
      for (const r of ranks) {
        const have = m0.get(r) || 0;
        needW += Math.max(0, 3 - have);
      }
      if (needW > w0) continue;

      // compute wings by removing triple allocations (real first, then wild)
      const used = new Map();
      let wildLeft = w0;
      for (const r of ranks) {
        const have = m0.get(r) || 0;
        const take = Math.min(3, have);
        used.set(r, take);
        const need = 3 - take;
        used.set('3', (used.get('3') || 0) + need);
        wildLeft -= need;
      }

      const wings = [];
      for (const c of cards) {
        const r = c.r;
        const u = used.get(r) || 0;
        if (u > 0) used.set(r, u - 1);
        else wings.push(r);
      }
      if (wings.length !== wingsNeeded) continue;

      // main is highest triple rank
      let main = ranks[0];
      for (const r of ranks) {
        if (rankValue(r) > rankValue(main)) main = r;
      }

      const cand = { ok:true, type: hasWings ? 'PLANE_WINGS' : 'PLANE', main, k, size:n, cards };
      if (!best || rankValue(cand.main) > rankValue(best.main)) best = cand;
    }
  }

  return best;
}

export function canBeat(prev, next) {
  // prev/next: classifyPlay outputs with ok=true
  if (!prev) return true; // starting trick

  const mainV = (p) => {
    const m = p.mainEffective || p.main;
    return rankValue(m);
  };

  if (next.type === 'BOMB' && prev.type !== 'BOMB') return true;
  if (next.type === 'BOMB' && prev.type === 'BOMB') {
    return mainV(next) > mainV(prev);
  }

  if (prev.type !== next.type) return false;

  switch (next.type) {
    case 'SINGLE':
    case 'PAIR':
    case 'TRIPLE':
      return mainV(next) > mainV(prev);
    case 'TRIPLE_SINGLE':
      return mainV(next) > mainV(prev);
    case 'STRAIGHT':
      if (next.len !== prev.len) return false;
      return mainV(next) > mainV(prev);
    case 'DOUBLE_DRAGON':
      if (next.len !== prev.len) return false;
      return mainV(next) > mainV(prev);
    case 'PLANE':
      if (next.k !== prev.k) return false;
      return mainV(next) > mainV(prev);
    case 'PLANE_WINGS':
      if (next.k !== prev.k) return false;
      return mainV(next) > mainV(prev);
    default:
      return false;
  }
}

export function formatCards(cards) {
  return cards.map(c => c.r).join(' ');
}

function groupByRank(hand) {
  const m = new Map();
  for (const c of hand) {
    const arr = m.get(c.r) || [];
    arr.push(c);
    m.set(c.r, arr);
  }
  return m;
}

function takeN(arr, n) {
  return arr.slice(0, n);
}

function pickWithWilds(hand, needMap, wildsNeeded) {
  // needMap: Map rank->count (excluding '3'); wildsNeeded: count of 3s
  const by = groupByRank(hand);
  const picked = [];
  for (const [r, cnt] of needMap.entries()) {
    const have = by.get(r) || [];
    if (have.length < cnt) return null;
    picked.push(...takeN(have, cnt));
  }
  const wilds = by.get('3') || [];
  if (wilds.length < wildsNeeded) return null;
  picked.push(...takeN(wilds, wildsNeeded));
  return picked;
}

export function generateCandidates(hand) {
  // Returns array of plays (each is array of card objects) for baseline AI.
  // Includes singles/pairs/triples/bombs/straights/double-dragons/planes(only without wings for now)/plane-wings.
  const sorted = sortHand(hand);
  const by = groupByRank(sorted);
  const wilds = (by.get('3') || []).length;

  const ranks = ['4','5','6','7','8','9','10','J','Q','K','A','2'];

  const plays = [];

  // singles
  for (const c of sorted) plays.push([c]);

  // pairs/triples/quads with wilds
  for (const r of ranks) {
    const have = (by.get(r) || []).length;
    for (const size of [2,3,4]) {
      const needWild = Math.max(0, size - have);
      if (needWild <= wilds && have + needWild === size) {
        const needMap = new Map();
        needMap.set(r, Math.min(have, size));
        const pick = pickWithWilds(sorted, needMap, needWild);
        if (pick) plays.push(pick);
      }
    }
  }

  // straights (len 5..12, no 2)
  for (let len = 5; len <= 12; len++) {
    for (let start = 4; start <= 14 - len + 1; start++) {
      const needMap = new Map();
      let needWild = 0;
      const usedRanks = [];
      for (let v = start; v < start + len; v++) {
        const r = valueToRank(v);
        usedRanks.push(r);
        const have = (by.get(r) || []).length;
        if (have >= 1) needMap.set(r, 1);
        else needWild += 1;
      }
      if (needWild > wilds) continue;
      // ensure no extra non-wild ranks outside window are included: we just pick required cards.
      const pick = pickWithWilds(sorted, needMap, needWild);
      if (pick) plays.push(pick);
    }
  }

  // double dragon (consecutive pairs len>=3, no 2)
  for (let len = 3; len <= 10; len++) {
    for (let start = 4; start <= 14 - len + 1; start++) {
      const needMap = new Map();
      let needWild = 0;
      for (let v = start; v < start + len; v++) {
        const r = valueToRank(v);
        const have = (by.get(r) || []).length;
        const take = Math.min(2, have);
        if (take > 0) needMap.set(r, take);
        needWild += (2 - take);
      }
      if (needWild > wilds) continue;
      const pick = pickWithWilds(sorted, needMap, needWild);
      if (pick) plays.push(pick);
    }
  }

  // triple + single (三带一)
  for (const r of ranks) {
    const have = (by.get(r) || []).length;
    const needWild = Math.max(0, 3 - have);
    if (needWild > wilds) continue;
    if (have + needWild !== 3) continue;

    const needMap = new Map();
    needMap.set(r, Math.min(have, 3));
    const triplePick = pickWithWilds(sorted, needMap, needWild);
    if (!triplePick) continue;

    const usedIds = new Set(triplePick.map(c => c.id));
    const remaining = sorted.filter(c => !usedIds.has(c.id));
    if (remaining.length >= 1) {
      plays.push([...triplePick, remaining[0]]);
    }
  }

  // planes and plane+wings (single wings)
  for (let k = 2; k <= 5; k++) {
    for (let start = 4; start <= 14 - k + 1; start++) {
      // plane without wings
      {
        const needMap = new Map();
        let needWild = 0;
        for (let v = start; v < start + k; v++) {
          const r = valueToRank(v);
          const have = (by.get(r) || []).length;
          const take = Math.min(3, have);
          if (take > 0) needMap.set(r, take);
          needWild += (3 - take);
        }
        if (needWild <= wilds) {
          const pick = pickWithWilds(sorted, needMap, needWild);
          if (pick) plays.push(pick);
        }
      }
      // plane with wings (k singles)
      {
        const needMap = new Map();
        let needWild = 0;
        // allocate triples
        for (let v = start; v < start + k; v++) {
          const r = valueToRank(v);
          const have = (by.get(r) || []).length;
          const take = Math.min(3, have);
          if (take > 0) needMap.set(r, take);
          needWild += (3 - take);
        }
        if (needWild > wilds) continue;
        const basePick = pickWithWilds(sorted, needMap, needWild);
        if (!basePick) continue;
        // wings from remaining cards
        const usedIds = new Set(basePick.map(c => c.id));
        const remaining = sorted.filter(c => !usedIds.has(c.id));
        if (remaining.length < k) continue;
        plays.push([...basePick, ...remaining.slice(0, k)]);
      }
    }
  }

  // de-dup by ids signature
  const seen = new Set();
  const uniq = [];
  for (const p of plays) {
    const sig = p.map(c=>c.id).sort().join(',');
    if (seen.has(sig)) continue;
    seen.add(sig);
    uniq.push(p);
  }
  return uniq;
}
