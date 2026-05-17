import { useState, useEffect, useRef, useCallback } from 'react';
import GameCanvas from './components/GameCanvas';
import BetPanel from './components/BetPanel';
import PlayerList from './components/PlayerList';
import HistoryStrip from './components/HistoryStrip';
import ProvablyFairDrawer from './components/ProvablyFairDrawer';

interface Bet {
  playerId: string;
  amount: number;
  autoCashout?: number;
  cashedOut: boolean;
  isBot: boolean;
  botName?: string;
  profit?: number;
  cashoutMultiplier?: number;
}

interface GameState {
  roundNumber: number;
  phase: 'BETTING' | 'FLYING' | 'CRASHED' | 'RESULT';
  currentMultiplier: number;
  crashPoint?: number;
  serverSeed?: string;
  hashCommit?: string;
  bets: Bet[];
  history: Array<{ roundNumber: number; crashPoint: number }>;
  countdownMs?: number;
}

export default function App() {
  const [gameState, setGameState] = useState<GameState>({
    roundNumber: 0,
    phase: 'BETTING',
    currentMultiplier: 1.0,
    bets: [],
    history: [],
  });
  const [balance, setBalance] = useState(1000);
  const [betAmount, setBetAmount] = useState(10);
  const [autoCashoutEnabled, setAutoCashoutEnabled] = useState(false);
  const [autoCashout, setAutoCashout] = useState(2.0);
  const [playerId] = useState(`player-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const [hasBet, setHasBet] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  // ─── WebSocket ────────────────────────────────────────────────────────────
  useEffect(() => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Connected to game server');
      ws.send(JSON.stringify({ type: 'get_balance', data: { playerId } }));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleMessage(message);
    };

    ws.onclose = () => {
      setTimeout(() => {
        const newWs = new WebSocket(`ws://${location.host}/ws`);
        wsRef.current = newWs;
        newWs.onopen = () => {
          newWs.send(JSON.stringify({ type: 'get_balance', data: { playerId } }));
        };
        newWs.onmessage = (e) => handleMessage(JSON.parse(e.data));
      }, 1500);
    };

    return () => ws.close();
  }, [playerId]);

  const handleMessage = useCallback((message: any) => {
    switch (message.type) {
      case 'join':
        setGameState(message.data);
        setHasBet(false);
        break;

      case 'phase_change':
        setGameState((prev) => ({
          ...prev,
          phase: message.data.phase,
          roundNumber: message.data.roundNumber,
          hashCommit: message.data.hashCommit,
          countdownMs: message.data.countdownMs,
          history: message.data.history || prev.history,
          bets: message.data.bets || prev.bets,
          currentMultiplier: message.data.phase === 'FLYING' ? 1.0 : prev.currentMultiplier,
        }));
        if (message.data.phase === 'BETTING') {
          setHasBet(false);
        }
        break;

      case 'multiplier_update':
        setGameState((prev) => ({
          ...prev,
          currentMultiplier: message.data.multiplier,
        }));
        break;

      case 'crash':
        setGameState((prev) => ({
          ...prev,
          phase: 'CRASHED',
          crashPoint: message.data.crashPoint,
          serverSeed: message.data.serverSeed,
          bets: message.data.bets,
        }));
        setHasBet(false);
        break;

      case 'countdown_update':
        setGameState((prev) => ({
          ...prev,
          countdownMs: message.data.countdownMs,
        }));
        break;

      case 'bet_placed':
        setBalance(message.data.balance);
        setHasBet(true);
        break;

      case 'cashout_success':
        setBalance(message.data.balance);
        setHasBet(false);
        break;

      case 'cashout':
        setGameState((prev) => ({
          ...prev,
          bets: prev.bets.map((b) =>
            b.playerId === message.data.playerId
              ? { ...b, cashedOut: true, cashoutMultiplier: message.data.multiplier, profit: message.data.profit }
              : b
          ),
        }));
        break;

      case 'new_bet':
        setGameState((prev) => ({
          ...prev,
          bets: [...prev.bets, {
            playerId: message.data.playerId,
            amount: message.data.amount,
            cashedOut: false,
            isBot: message.data.isBot,
            botName: message.data.isBot ? `Bot-${message.data.playerId.slice(-4)}` : undefined,
          }],
        }));
        break;

      case 'balance':
        setBalance(message.data.balance);
        break;

      case 'error':
        console.warn('Server error:', message.data.message);
        break;
    }
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────────
  const placeBet = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'place_bet',
      data: {
        playerId,
        amount: betAmount,
        autoCashout: autoCashoutEnabled ? autoCashout : undefined,
      },
    }));
  };

  const cashout = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'cashout',
      data: { playerId },
    }));
  };

  const resetBalance = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'reset_balance',
      data: { playerId },
    }));
  };

  const getChipClass = (crashPoint: number) => {
    if (crashPoint < 2) return 'pink';
    if (crashPoint < 10) return 'purple';
    return 'gold';
  };

  const getChipColor = (crashPoint: number) => {
    if (crashPoint < 2) return '#fd79a8';
    if (crashPoint < 10) return '#a78bfa';
    return '#ffab00';
  };

  const getMultiplierColor = (m: number) => {
    if (m >= 10) return '#ff1744';
    if (m >= 5) return '#ff9100';
    if (m >= 2) return '#ffab00';
    return '#00e676';
  };

  const getCountdownSeconds = () => {
    if (!gameState.countdownMs || gameState.phase !== 'BETTING') return 0;
    return Math.max(0, Math.ceil(gameState.countdownMs / 1000));
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a2e] via-[#1a1a4e] to-[#0d0d3a] text-white overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-black/30 backdrop-blur-sm border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center">
            <span className="text-lg">✈</span>
          </div>
          <h1 className="text-lg font-bold tracking-wide">
            <span className="bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
              CRASH
            </span>
            <span className="text-gray-400 ml-1">GAME</span>
          </h1>
        </div>

        <div className="flex items-center gap-4">
          {/* Provably Fair Button */}
          <button
            onClick={() => setDrawerOpen(true)}
            className="text-xs text-gray-400 hover:text-white transition-colors flex items-center gap-1"
          >
            <span>🔒</span> Provably Fair
          </button>

          {/* Balance */}
          <div className="bg-white/5 border border-white/10 rounded-lg px-4 py-2 flex items-center gap-3">
            <div>
              <div className="text-xs text-gray-400">Balance</div>
              <div className="text-lg font-bold text-green-400">${balance.toFixed(2)}</div>
            </div>
            <button
              onClick={resetBalance}
              className="text-xs text-gray-500 hover:text-white transition-colors px-2 py-1 rounded bg-white/5"
              title="Reset balance to $1000"
            >
              Reset
            </button>
          </div>
        </div>
      </header>

      {/* History Strip */}
      <HistoryStrip history={gameState.history} getChipClass={getChipClass} />

      {/* Main Content */}
      <div className="flex flex-col lg:flex-row gap-3 p-3 h-[calc(100vh-140px)]">
        {/* Game Canvas */}
        <div className="flex-1 relative rounded-xl overflow-hidden border border-white/10">
          <GameCanvas
            phase={gameState.phase}
            currentMultiplier={gameState.currentMultiplier}
            crashPoint={gameState.crashPoint}
            hashCommit={gameState.hashCommit}
            countdownMs={gameState.countdownMs}
            getMultiplierColor={getMultiplierColor}
          />
        </div>

        {/* Sidebar */}
        <div className="lg:w-80 flex flex-col gap-3">
          {/* Bet Panel */}
          <BetPanel
            phase={gameState.phase}
            hasBet={hasBet}
            balance={balance}
            betAmount={betAmount}
            setBetAmount={setBetAmount}
            autoCashoutEnabled={autoCashoutEnabled}
            setAutoCashoutEnabled={setAutoCashoutEnabled}
            autoCashout={autoCashout}
            setAutoCashout={setAutoCashout}
            currentMultiplier={gameState.currentMultiplier}
            betAmounts={[1, 5, 10, 25, 50, 100, 500]}
            onPlaceBet={placeBet}
            onCashout={cashout}
          />

          {/* Player List */}
          <PlayerList bets={gameState.bets} />
        </div>
      </div>

      {/* Footer */}
      <footer className="text-center py-2 text-xs text-gray-600 bg-black/20">
        This is a simulation for entertainment / demo purposes. No real money is involved.
      </footer>

      {/* Provably Fair Drawer */}
      <ProvablyFairDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        currentRound={gameState}
      />
    </div>
  );
}
