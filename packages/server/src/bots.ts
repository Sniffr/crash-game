const BOT_NAMES = [
  'Alex', 'Maria', 'Chen', 'Ivan', 'Sara', 'Mike', 'Luna', 'Oscar',
  'Yuki', 'Kai', 'Zara', 'Leo', 'Mia', 'Noah', 'Ella', 'Max',
  'Aria', 'Liam', 'Chloe', 'Ethan', 'Emma', 'James', 'Sophia', 'Oliver',
  'Isabella', 'Ben', 'Lily', 'Jack', 'Anna', 'Tom', 'Nina', 'Sam',
  'Rina', 'Hugo', 'Vera', 'Pablo', 'Inez', 'Theo', 'Diya', 'Reza',
];

export interface BotBet {
  playerId: string;
  amount: number;
  autoCashout?: number;
  isBot: true;
  botName: string;
}

let botSeq = 0;

function randomName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

/**
 * Plausible bot bet sizes — fat-tailed so most are small, some are big.
 * Roughly: 70% in [1, 50], 25% in [50, 250], 5% in [250, 1000].
 */
function sampleBotStake(): number {
  const r = Math.random();
  let raw: number;
  if (r < 0.7) raw = 1 + Math.random() * 49;
  else if (r < 0.95) raw = 50 + Math.random() * 200;
  else raw = 250 + Math.random() * 750;
  return Math.round(raw * 100) / 100;
}

/**
 * Bot auto-cashout targets favor the realistic 1.4x–3x band, with a long
 * tail of patient players going for 5x+.
 */
export function sampleBotAutoCashout(): number | undefined {
  const r = Math.random();
  if (r < 0.15) return undefined; // some bots ride it out manually (effectively crash)
  let raw: number;
  const t = Math.random();
  if (t < 0.55) raw = 1.2 + Math.random() * 1.8; // 1.2x–3.0x
  else if (t < 0.9) raw = 3 + Math.random() * 4; // 3x–7x
  else raw = 7 + Math.random() * 43; // 7x–50x optimists
  return Math.round(raw * 100) / 100;
}

/**
 * Generate `min`–`max` bot bets for a round. Defaults give a healthy 10–30.
 */
export function generateBotBets(
  roundNumber: number,
  min = 10,
  max = 30,
): BotBet[] {
  const count = min + Math.floor(Math.random() * (max - min + 1));
  const bets: BotBet[] = [];
  for (let i = 0; i < count; i++) {
    botSeq += 1;
    bets.push({
      playerId: `bot-${roundNumber}-${botSeq}`,
      amount: sampleBotStake(),
      autoCashout: sampleBotAutoCashout(),
      isBot: true,
      botName: randomName(),
    });
  }
  return bets;
}
