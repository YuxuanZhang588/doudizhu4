import {
  makeDeck, shuffle, sortHand,
  classifyPlay, canBeat, formatCards,
  generateCandidates
} from './rules.js';

const $ = (id) => document.getElementById(id);

const ui = {
  userName: $('userName'),
  saveUserBtn: $('saveUserBtn'),
  userStatus: $('userStatus'),

  newBtn: $('newBtn'),
  bidBtn: $('bidBtn'),
  passBidBtn: $('passBidBtn'),
  playBtn: $('playBtn'),
  passBtn: $('passBtn'),
  status: $('status'),
  hand: $('hand'),
  handCount: $('handCount'),
  selected: $('selected'),
  detected: $('detected'),
  trick: $('trick'),
  lastBy: $('lastBy'),
  landlord: $('landlord'),
  bottom: $('bottom'),
  log: $('log')
};

function log(msg) {
  ui.log.textContent += msg + '\n';
  ui.log.scrollTop = ui.log.scrollHeight;
}

const state = {
  phase: 'idle', // idle | bidding | playing | ended
  deck: [],
  hands: [[],[],[],[]],
  bottom: [],
  bottomRevealed: false,
  landlord: null,
  turn: 0,
  trick: null,
  lastBy: null,
  passes: 0,
  selectedIds: new Set(),
  bidTurn: 0,
  bids: [false,false,false,false],

  // analytics
  user: null,
  gameId: null,
  startedAt: null,
  events: [],

  // scoring/multipliers
  multiplier: 1,
  bombCount: 0,
  farmersPlayed: false,
  landlordPlayCount: 0,
  landlordOpened: false
};

function resetSelection() {
  state.selectedIds.clear();
  render();
}

function getYourHand() { return state.hands[0]; }

function selectedCards() {
  const hand = getYourHand();
  return hand.filter(c => state.selectedIds.has(c.id));
}

function renderHand() {
  const hand = sortHand(getYourHand());
  ui.hand.innerHTML = '';
  for (const c of hand) {
    const el = document.createElement('div');
    el.className = 'card' + (state.selectedIds.has(c.id) ? ' sel' : '');
    el.textContent = c.r;
    el.onclick = () => {
      if (state.phase !== 'playing') return;
      if (state.turn !== 0) return;
      if (state.selectedIds.has(c.id)) state.selectedIds.delete(c.id);
      else state.selectedIds.add(c.id);
      render();
    };
    ui.hand.appendChild(el);
  }
  ui.handCount.textContent = String(hand.length);

  const sel = selectedCards();
  ui.selected.textContent = sel.length ? formatCards(sel) : '(none)';
  const cls = sel.length ? classifyPlay(sel) : null;
  const typeZh = (t) => ({
    SINGLE: '单张',
    PAIR: '对子',
    TRIPLE: '三张',
    TRIPLE_SINGLE: '三带一',
    STRAIGHT: '顺子',
    DOUBLE_DRAGON: '双龙(连对)',
    PLANE: '飞机',
    PLANE_WINGS: '飞机带翅膀',
    BOMB: '炸弹'
  }[t] || t);

  if (!cls) ui.detected.textContent = '（无）';
  else if (!cls.ok) ui.detected.textContent = `不合法：${cls.reason}`;
  else {
    let extra = '';
    if (cls.type === 'STRAIGHT' && cls.mappedRanks) extra = ` ⇒ ${cls.mappedRanks.join(' ')}`;
    if (cls.type === 'DOUBLE_DRAGON' && cls.mappedRanks) extra = ` ⇒ ${cls.mappedRanks.join(' ')}（每张一对）`;
    const mainShow = cls.mainEffective ? `${cls.main}（当${cls.mainEffective}用）` : cls.main;
    ui.detected.textContent = `${typeZh(cls.type)}｜主牌=${mainShow}${extra}`;
  }
}

function renderTable() {
  ui.trick.textContent = state.trick ? `${state.trick.type} :: ${formatCards(state.trick.cards)}` : '(none)';
  ui.lastBy.textContent = state.lastBy == null ? '(none)' : `P${state.lastBy}`;
  ui.landlord.textContent = state.landlord == null ? '(none)' : `P${state.landlord}`;
  ui.bottom.textContent = state.bottomRevealed ? formatCards(state.bottom) : '（未公开）';
}

function renderButtons() {
  ui.bidBtn.disabled = !(state.phase === 'bidding' && state.bidTurn === 0);
  ui.passBidBtn.disabled = ui.bidBtn.disabled;

  const yourTurn = (state.phase === 'playing' && state.turn === 0);
  ui.playBtn.disabled = !yourTurn;

  // Landlord must lead the very first trick (cannot pass on first move)
  const firstLead = (state.phase === 'playing' && state.trick == null && state.lastBy == null);
  const youAreLandlord = (state.landlord === 0);
  ui.passBtn.disabled = !yourTurn || (firstLead && youAreLandlord);

  const phaseZh = state.phase === 'idle' ? '空闲' : state.phase === 'bidding' ? '抢地主' : state.phase === 'playing' ? '出牌中' : '结束';
  ui.status.textContent = `状态=${phaseZh}｜轮到=P${state.turn}`;
}

function render() {
  renderHand();
  renderTable();
  renderButtons();
}

function deal() {
  const deck = shuffle(makeDeck());
  state.deck = deck;
  state.hands = [[],[],[],[]];
  state.bottom = [];

  // deal 12 each (48) + bottom 4
  let idx = 0;
  for (let round = 0; round < 12; round++) {
    for (let p = 0; p < 4; p++) {
      state.hands[p].push(deck[idx++]);
    }
  }
  state.bottom = deck.slice(idx, idx + 4);
  state.bottomRevealed = false;
  for (let p = 0; p < 4; p++) state.hands[p] = sortHand(state.hands[p]);
}

function newGameId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function recordGameToServer(payload) {
  if (!state.user) {
    log('[记录] 未选择玩家名，已跳过对局存储。');
    return;
  }
  try {
    const res = await fetch('/api/record_game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: state.user, payload })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'unknown');
    log(`[记录] 已保存对局：user=${state.user} id=${j.id}`);
  } catch (e) {
    log(`[记录] 保存失败（仍可继续玩）：${e.message}`);
  }
}

function startGame() {
  ui.log.textContent = '';

  state.gameId = newGameId();
  state.startedAt = new Date().toISOString();
  state.events = [];

  // reset scoring/multipliers
  state.multiplier = 1;
  state.bombCount = 0;
  state.farmersPlayed = false;
  state.landlordPlayCount = 0;
  state.landlordOpened = false;

  deal();
  state.phase = 'bidding';
  state.landlord = null;
  state.trick = null;
  state.lastBy = null;
  state.passes = 0;
  state.turn = 0;
  state.bidTurn = 0;
  state.bids = [false,false,false,false];
  resetSelection();

  // store initial snapshot (for replay/debug)
  state.events.push({
    t: Date.now(),
    type: 'start',
    game_id: state.gameId,
    user: state.user,
    deck: state.deck.map(c => ({ id: c.id, r: c.r })),
    hands: state.hands.map(h => h.map(c => ({ id: c.id, r: c.r }))),
    bottom: state.bottom.map(c => ({ id: c.id, r: c.r }))
  });

  log('新开一局。P0（你）先抢地主。底牌暂不公开。');
  render();
}

function finishBidding() {
  // choose first bidder who said yes; if none, default P0
  let ll = state.bids.findIndex(b => b);
  if (ll === -1) ll = 0;
  state.landlord = ll;

  state.events.push({ t: Date.now(), type: 'bidding_end', landlord: ll, bids: [...state.bids] });

  state.hands[ll].push(...state.bottom);
  state.hands[ll] = sortHand(state.hands[ll]);
  state.bottomRevealed = true;
  state.phase = 'playing';
  state.turn = ll;
  state.trick = null;
  state.lastBy = null;
  state.passes = 0;
  log(`地主是 P${ll}。底牌：${formatCards(state.bottom)}。地主现在 ${state.hands[ll].length} 张。`);
  render();
  maybeBotTurn();
}

function stepBid(nextYes) {
  state.bids[state.bidTurn] = nextYes;
  state.events.push({ t: Date.now(), type: 'bid', p: state.bidTurn, yes: !!nextYes });
  log(`P${state.bidTurn} ${nextYes ? '抢地主' : '不抢'}`);
  state.bidTurn = (state.bidTurn + 1) % 4;

  // after one full round, finish.
  if (state.bidTurn === 0) {
    finishBidding();
    return;
  }
  render();
  maybeBotTurn();
}

function removeCardsFromHand(p, cards) {
  const ids = new Set(cards.map(c => c.id));
  state.hands[p] = state.hands[p].filter(c => !ids.has(c.id));
}

function playCards(p, cards) {
  const cls = classifyPlay(cards);
  if (!cls.ok) throw new Error(cls.reason);
  if (!canBeat(state.trick, cls)) throw new Error('does not beat current trick');

  const isOpeningLead = (state.trick == null && state.lastBy == null);

  // log before mutating too much
  state.events.push({
    t: Date.now(),
    type: 'play',
    p,
    opening_lead: isOpeningLead,
    cards: cards.map(c => ({ id: c.id, r: c.r })),
    cls: { ok: cls.ok, type: cls.type, main: cls.main, mainEffective: cls.mainEffective || null }
  });

  // multiplier rules: bomb doubles
  if (cls.type === 'BOMB') {
    state.bombCount += 1;
    state.multiplier *= 2;
    state.events.push({ t: Date.now(), type: 'multiplier', reason: 'bomb', multiplier: state.multiplier, bombCount: state.bombCount });
    log(`[翻倍] 炸弹！倍率 x2 => 当前倍率=${state.multiplier}`);
  }

  // spring bookkeeping
  if (state.landlord != null) {
    if (p === state.landlord) {
      state.landlordPlayCount += 1;
      if (isOpeningLead) state.landlordOpened = true;
    } else {
      state.farmersPlayed = true;
    }
  }

  removeCardsFromHand(p, cards);

  // report low cards (<=3) after the play is applied
  const left = state.hands[p].length;
  if (left <= 3 && left > 0) {
    state.events.push({ t: Date.now(), type: 'report_left', p, left });
    log(`[报片] P${p} 还剩 ${left} 张！`);
  }

  state.trick = cls;
  state.lastBy = p;
  state.passes = 0;

  log(`P${p} 出牌：${cls.type} :: ${formatCards(cards)} (主牌 ${cls.main})`);

  if (left === 0) {
    state.phase = 'ended';
    const endedAt = new Date().toISOString();
    const winnerP = p;

    // spring rules (per your definition)
    let spring = false;
    let springType = null;

    // landlord spring: farmers never played any card
    if (winnerP === state.landlord && state.farmersPlayed === false) {
      spring = true;
      springType = 'landlord';
    }

    // farmers spring: landlord played only the opening lead once, then never played again
    if (winnerP !== state.landlord && state.landlordOpened === true && state.landlordPlayCount === 1) {
      spring = true;
      springType = 'farmers';
    }

    if (spring) {
      state.multiplier *= 2;
      state.events.push({ t: Date.now(), type: 'multiplier', reason: 'spring', springType, multiplier: state.multiplier });
      log(`[翻倍] ${springType === 'landlord' ? '地主春天' : '农民春天'}！倍率 x2 => 当前倍率=${state.multiplier}`);
    }

    log(`游戏结束。赢家：P${winnerP}（${winnerP === state.landlord ? '地主' : '农民'}）｜倍率=${state.multiplier}（炸弹${state.bombCount}次${spring ? ' + 春天' : ''}）`);

    // final payload
    const payload = {
      game_id: state.gameId,
      user: state.user,
      started_at: state.startedAt,
      ended_at: endedAt,
      winner_p: winnerP,
      landlord_p: state.landlord,
      bids: state.bids,
      multiplier: state.multiplier,
      bomb_count: state.bombCount,
      spring,
      spring_type: springType,
      landlord_opened: state.landlordOpened,
      landlord_play_count: state.landlordPlayCount,
      farmers_played: state.farmersPlayed,
      events: state.events,
      final_hands_count: state.hands.map(h => h.length)
    };
    recordGameToServer(payload);
  }
}

function pass(p) {
  state.events.push({ t: Date.now(), type: 'pass', p });
  state.passes++;
  log(`P${p} 不要。`);
  if (state.passes >= 3) {
    // reset trick; lastBy leads
    state.trick = null;
    state.passes = 0;
    state.turn = state.lastBy;
    state.events.push({ t: Date.now(), type: 'trick_reset', next_turn: state.turn });
    log(`本轮结束。P${state.turn} 先出。`);
  }
}

function nextTurn() {
  state.turn = (state.turn + 1) % 4;
}

function botChoosePlay(p) {
  // Rule-based baseline AI:
  // - Enumerate candidate plays from current hand (with wild handling)
  // - If leading: prefer longer structure plays (plane_wings/plane/double_dragon/straight), else low singles
  // - If following: choose the smallest play that beats current trick; avoid bombing unless necessary

  const hand = sortHand(state.hands[p]);
  const cands = generateCandidates(hand).map(cards => ({ cards, cls: classifyPlay(cards) })).filter(x => x.cls.ok);

  const isLeading = !state.trick;
  if (isLeading) {
    const scoreLead = (x) => {
      const t = x.cls.type;
      const size = x.cards.length;
      // prefer shedding more cards using structures
      let bonus = 0;
      if (t === 'PLANE_WINGS') bonus = 400;
      else if (t === 'PLANE') bonus = 350;
      else if (t === 'DOUBLE_DRAGON') bonus = 300;
      else if (t === 'STRAIGHT') bonus = 250;
      else if (t === 'TRIPLE') bonus = 80;
      else if (t === 'PAIR') bonus = 50;
      else if (t === 'SINGLE') bonus = 10;
      else if (t === 'BOMB') bonus = -200; // don't open with bomb
      // lower main preferred when leading
      return bonus + size * 2 - (x.cls.mainEffective ? 200 : 0) - (x.cls.main ? 0 : 0);
    };

    cands.sort((a,b) => scoreLead(b) - scoreLead(a));
    // take best non-bomb if possible
    const best = cands.find(x => x.cls.type !== 'BOMB') || cands[0];
    return best ? best.cards : null;
  }

  // following: only consider those that beat
  const beating = cands.filter(x => canBeat(state.trick, x.cls));
  if (beating.length === 0) return null;

  const scoreFollow = (x) => {
    const t = x.cls.type;
    let cost = 0;
    // avoid bombs unless opponent near win
    if (t === 'BOMB') cost += 1000;
    // prefer small main
    const main = x.cls.mainEffective || x.cls.main;
    cost += (main === '2' ? 200 : 0);
    cost += x.cards.length * 3;
    return cost;
  };
  beating.sort((a,b) => scoreFollow(a) - scoreFollow(b));
  return beating[0].cards;
}

function maybeBotTurn() {
  if (state.phase === 'ended') return;

  // bidding bots
  if (state.phase === 'bidding') {
    if (state.bidTurn === 0) return;
    // bots bid randomly with low probability
    const yes = Math.random() < 0.35;
    setTimeout(() => stepBid(yes), 300);
    return;
  }

  if (state.phase !== 'playing') return;
  if (state.turn === 0) return;

  const p = state.turn;
  setTimeout(() => {
    if (state.phase !== 'playing') return;
    try {
      let pick = botChoosePlay(p);
      if (!pick) {
        // If landlord is leading the first trick, passing is not allowed.
        const firstLead = (state.trick == null && state.lastBy == null);
        if (firstLead && state.landlord === p) {
          pick = [sortHand(state.hands[p])[0]];
        }
      }

      if (pick) playCards(p, pick);
      else pass(p);
    } catch (e) {
      log(`P${p} bot error: ${e.message}`);
      pass(p);
    }

    if (state.phase === 'playing') {
      // Only advance turn if this actor is still the current turn.
      // (If a PASS caused trick reset, pass() will set state.turn to lastBy.)
      if (state.turn === p) nextTurn();
      render();
      maybeBotTurn();
    } else {
      render();
    }
  }, 350);
}

function setUser(u) {
  const user = (u || '').trim();
  if (!user) {
    ui.userStatus.textContent = '（未设置）';
    state.user = null;
    localStorage.removeItem('doudizhu_user');
    return;
  }
  // validate same as server: 1-32 [a-zA-Z0-9_-]
  if (!/^[a-zA-Z0-9_\-]{1,32}$/.test(user)) {
    ui.userStatus.textContent = '名字不合法：仅允许 1-32 位 a-zA-Z0-9_-';
    return;
  }
  state.user = user;
  ui.userName.value = user;
  ui.userStatus.textContent = `当前：${user}`;
  localStorage.setItem('doudizhu_user', user);
}

// UI handlers
ui.saveUserBtn.onclick = () => setUser(ui.userName.value);
ui.newBtn.onclick = () => startGame();
ui.bidBtn.onclick = () => stepBid(true);
ui.passBidBtn.onclick = () => stepBid(false);

ui.playBtn.onclick = () => {
  if (state.phase !== 'playing' || state.turn !== 0) return;
  const cards = selectedCards();
  if (cards.length === 0) return;

  try {
    playCards(0, cards);
    resetSelection();
    if (state.phase === 'playing') {
      if (state.turn === 0) nextTurn();
      render();
      maybeBotTurn();
    } else {
      render();
    }
  } catch (e) {
    log(`[你] 出牌不合法: ${e.message}`);
  }
};

ui.passBtn.onclick = () => {
  if (state.phase !== 'playing' || state.turn !== 0) return;
  const firstLead = (state.trick == null && state.lastBy == null);
  if (firstLead && state.landlord === 0) {
    log('[规则] 地主第一轮必须出牌，不能不要。');
    return;
  }
  pass(0);
  resetSelection();
  if (state.phase === 'playing') {
    if (state.turn === 0) nextTurn();
    render();
    maybeBotTurn();
  }
};

function randomUser() {
  // 8 hex chars
  const suffix = Math.random().toString(16).slice(2, 10);
  return `guest-${suffix}`;
}

// init
render();
{
  const stored = localStorage.getItem('doudizhu_user') || '';
  if (stored && stored.trim()) setUser(stored);
  else setUser(randomUser());
}
log('Click New Game to start.');
