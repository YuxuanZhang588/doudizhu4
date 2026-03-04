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
  resetRoundBtn: $('resetRoundBtn'),
  leaderboardBtn: $('leaderboardBtn'),
  leaderboardModal: $('leaderboardModal'),
  closeLeaderboard: $('closeLeaderboard'),
  leaderboardBody: $('leaderboardBody'),
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
  log: $('log'),

  gamesPlayed: $('gamesPlayed'),
  scoreP1: $('scoreP1'),
  scoreP2: $('scoreP2'),
  scoreP3: $('scoreP3'),
  scoreP4: $('scoreP4'),
  modelBadge: $('modelBadge')
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
  landlordOpened: false,

  // cumulative performance stats
  stats: {
    gamesPlayed: 0,
    totalScores: [0, 0, 0, 0]
  }
};

function statsStorageKey() {
  const u = (state.user || 'anonymous').trim();
  return `doudizhu_stats_${u}`;
}

function saveStats() {
  try {
    localStorage.setItem(statsStorageKey(), JSON.stringify(state.stats));
  } catch (_) {}
}

function loadStats() {
  state.stats = { gamesPlayed: 0, totalScores: [0, 0, 0, 0] };
  try {
    const raw = localStorage.getItem(statsStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const gp = Number(parsed.gamesPlayed);
    const ts = Array.isArray(parsed.totalScores) ? parsed.totalScores.map(Number) : null;
    if (!Number.isFinite(gp) || !ts || ts.length !== 4 || ts.some(v => !Number.isFinite(v))) return;
    state.stats = { gamesPlayed: gp, totalScores: ts };
  } catch (_) {}
}

function resetStats() {
  state.stats = { gamesPlayed: 0, totalScores: [0, 0, 0, 0] };
  saveStats();
  render();
  log('[战绩] 已清空总积分与已玩局数。');
}

function applyGameScore(winnerP) {
  if (state.landlord == null) return;
  const base = state.multiplier;
  const delta = [0, 0, 0, 0];

  if (winnerP === state.landlord) {
    delta[state.landlord] += 3 * base;
    for (let p = 0; p < 4; p++) {
      if (p !== state.landlord) delta[p] -= 1 * base;
    }
  } else {
    delta[state.landlord] -= 3 * base;
    for (let p = 0; p < 4; p++) {
      if (p !== state.landlord) delta[p] += 1 * base;
    }
  }

  state.stats.gamesPlayed += 1;
  for (let p = 0; p < 4; p++) {
    state.stats.totalScores[p] += delta[p];
  }
  saveStats();

  log(`[战绩] 本局积分变化：P0 ${delta[0] >= 0 ? '+' : ''}${delta[0]}｜P1 ${delta[1] >= 0 ? '+' : ''}${delta[1]}｜P2 ${delta[2] >= 0 ? '+' : ''}${delta[2]}｜P3 ${delta[3] >= 0 ? '+' : ''}${delta[3]}`);
}

// Leaderboard functions
function getAllUserStats() {
  const allStats = [];
  // Iterate through localStorage to find all doudizhu_stats_* entries
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('doudizhu_stats_')) {
      try {
        const username = key.replace('doudizhu_stats_', '');
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') continue;
        const gamesPlayed = Number(parsed.gamesPlayed) || 0;
        const totalScores = Array.isArray(parsed.totalScores) ? parsed.totalScores.map(Number) : [0, 0, 0, 0];
        
        // Calculate wins (when P0's score increased)
        // We approximate wins by total score / 3 (landlord win) or / 1 (farmer win)
        // A better approach: wins = games where totalScores[0] increased
        // But we only have cumulative data, so we estimate based on score
        const playerScore = totalScores[0]; // P0 is the player
        
        allStats.push({
          username,
          gamesPlayed,
          totalScore: playerScore,
          totalScores
        });
      } catch (_) {}
    }
  }
  return allStats;
}

function calculateWinRate(stats) {
  if (stats.gamesPlayed === 0) return 0;
  // Rough win rate estimation: if average score > 0, win rate > 50%
  // Better approximation: assume landlord is selected 25% of time (1/4 players)
  // Landlord win = +3, loss = -3; Farmer win = +1, loss = -1
  // Expected value per game assuming 50% win rate as landlord/farmer:
  // 0.25 * (0.5*3 + 0.5*(-3)) + 0.75 * (0.5*1 + 0.5*(-1)) = 0
  // If avgScore > 0, then winRate > 50%
  
  const avgScore = stats.totalScore / stats.gamesPlayed;
  
  // Linear approximation: 
  // avgScore = 0 => 50% win rate
  // avgScore = 2 => 100% win rate (very optimistic)
  // avgScore = -2 => 0% win rate
  const winRate = 50 + (avgScore / 2) * 50;
  return Math.max(0, Math.min(100, winRate)); // Clamp to [0, 100]
}

function showLeaderboard() {
  const allStats = getAllUserStats();
  
  // Sort by win rate (and games played as tiebreaker)
  allStats.sort((a, b) => {
    const wrA = calculateWinRate(a);
    const wrB = calculateWinRate(b);
    if (Math.abs(wrA - wrB) > 0.1) return wrB - wrA; // Higher win rate first
    return b.gamesPlayed - a.gamesPlayed; // More games first
  });
  
  // Render leaderboard
  const tbody = ui.leaderboardBody;
  tbody.innerHTML = '';
  
  if (allStats.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center">暂无数据</td></tr>';
  } else {
    allStats.forEach((stat, idx) => {
      const rank = idx + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '';
      const winRate = calculateWinRate(stat).toFixed(1);
      
      const row = document.createElement('tr');
      row.innerHTML = `
        <td><span class="rank-medal">${medal}</span>${rank}</td>
        <td><b>${stat.username}</b></td>
        <td>${winRate}%</td>
        <td>${stat.gamesPlayed}</td>
        <td>${stat.totalScore >= 0 ? '+' : ''}${stat.totalScore}</td>
      `;
      tbody.appendChild(row);
    });
  }
  
  ui.leaderboardModal.classList.add('show');
}

function hideLeaderboard() {
  ui.leaderboardModal.classList.remove('show');
}

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
    QUAD_WINGS: '四带二',
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

function renderStats() {
  ui.gamesPlayed.textContent = String(state.stats.gamesPlayed);
  ui.scoreP1.textContent = String(state.stats.totalScores[0]);
  ui.scoreP2.textContent = String(state.stats.totalScores[1]);
  ui.scoreP3.textContent = String(state.stats.totalScores[2]);
  ui.scoreP4.textContent = String(state.stats.totalScores[3]);
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
  renderStats();
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
  // Check if user is set
  if (!state.user || !state.user.trim()) {
    ui.status.textContent = '⚠️ 请先输入用户名或从下拉菜单中选择！';
    ui.userName.focus();
    log('[错误] 请先输入用户名再开始游戏。');
    return;
  }
  
  ui.log.textContent = '';
  ui.status.textContent = '';

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

    applyGameScore(winnerP);

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

function botChoosePlayRuleBased(p) {
  // Rule-based baseline AI (original implementation)
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
      else if (t === 'QUAD_WINGS') bonus = 380;
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

async function botChoosePlayAI(p) {
  // AI-powered decision making using trained neural network model
  try {
    const response = await fetch('/api/get_ai_action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        game_state: {
          hands: state.hands,
          landlord: state.landlord,
          trick: state.trick,
          lastBy: state.lastBy,
          passes: state.passes,
          events: state.events,
          bombCount: state.bombCount
        },
        player_position: p
      })
    });
    
    if (!response.ok) {
      console.warn(`AI API failed with status ${response.status}, falling back to rule-based`);
      return botChoosePlayRuleBased(p);
    }
    
    const data = await response.json();
    
    if (!data.ok) {
      console.warn(`AI API error: ${data.error}, falling back to rule-based`);
      return botChoosePlayRuleBased(p);
    }
    
    if (data.action === null) {
      return null; // AI decided to pass
    }
    
    // Convert AI action (which has dummy suits) to actual cards from hand
    const hand = state.hands[p];
    const action = data.action;
    const result = [];
    const handCopy = [...hand];
    
    for (const aiCard of action) {
      // Find matching card in hand by rank
      const idx = handCopy.findIndex(c => c.r === aiCard.r);
      if (idx >= 0) {
        result.push(handCopy[idx]);
        handCopy.splice(idx, 1);
      }
    }
    
    if (result.length !== action.length) {
      console.warn('AI returned invalid action, falling back to rule-based');
      return botChoosePlayRuleBased(p);
    }
    
    // Log AI inference time
    if (data.elapsed_ms) {
      console.log(`AI P${p} decision took ${data.elapsed_ms}ms`);
    }
    
    return result;
    
  } catch (error) {
    console.error('AI error:', error);
    console.log('Falling back to rule-based AI');
    return botChoosePlayRuleBased(p);
  }
}

async function botChoosePlay(p) {
  // Unified bot decision function: try AI first, fallback to rules
  return await botChoosePlayAI(p);
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
  setTimeout(async () => {
    if (state.phase !== 'playing') return;
    try {
      let pick = await botChoosePlay(p);
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
  loadStats();
  render();
}

// UI handlers
ui.saveUserBtn.onclick = () => setUser(ui.userName.value);
ui.newBtn.onclick = () => startGame();
ui.resetRoundBtn.onclick = () => resetStats();
ui.leaderboardBtn.onclick = () => showLeaderboard();
ui.closeLeaderboard.onclick = () => hideLeaderboard();
ui.leaderboardModal.onclick = (e) => {
  // Close modal when clicking outside the content
  if (e.target === ui.leaderboardModal) hideLeaderboard();
};
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

// init
render();
{
  const stored = localStorage.getItem('doudizhu_user') || '';
  if (stored && stored.trim()) {
    setUser(stored);
    log('欢迎回来！点击"新开一局"开始游戏。');
  } else {
    state.user = null;
    ui.userStatus.textContent = '请输入用户名';
    log('请先输入用户名或从下拉菜单选择（Lin, Hua, YZ），然后点击"使用"按钮。');
  }
}

async function fetchModelInfo() {
  if (!ui.modelBadge) return;
  try {
    const res = await fetch('/api/model_info');
    const info = await res.json();
    const dot = ui.modelBadge.querySelector('.dot');
    if (dot) dot.classList.remove('loading');
    if (!info.ai_enabled) {
      ui.modelBadge.innerHTML = '<span class="dot" style="background:#f85149"></span><span>AI 未启用（规则对手）</span>';
      return;
    }
    const frames = info.frames ? `${(info.frames / 1e6).toFixed(1)}M帧` : '';
    const wp = info.wp_vs_random ? ` · 胜率 ${(info.wp_vs_random * 100).toFixed(1)}% vs random` : '';
    ui.modelBadge.innerHTML =
      `<span class="dot"></span>对战模型：<b>${info.name || 'unknown'}</b>` +
      (frames ? ` <span style="color:#9aa4b2">(${frames}${wp})</span>` : '');
  } catch (_) {
    if (ui.modelBadge) ui.modelBadge.innerHTML = '<span class="dot" style="background:#f85149"></span><span>模型信息获取失败</span>';
  }
}

fetchModelInfo();
