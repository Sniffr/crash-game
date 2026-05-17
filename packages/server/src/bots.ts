const BOT_NAMES = [
  'Alex', 'Maria', 'Chen', 'Ivan', 'Sara', 'Mike', 'Luna', 'Oscar',
  'Yuki', 'Kai', 'Zara', 'Leo', 'Mia', 'Noah', 'Ella', 'Max',
  'Aria', 'Liam', 'Chloe', 'Ethan', 'Emma', 'James', 'Sophia', 'Oliver',
  'Isabella', 'Ben', 'Lily', 'Jack', 'Anna', 'Tom', 'Nina', 'Sam'
];

export interface BotBet {
  playerId: string;
  amount: number;
  autoCashout?: number;
  isBot: true;
  botName: string;
}

/**
 * Generate 10-30 bot bets for a round.
 * Each bot has a random stake and optional auto-cashout.
 */
export function generateBotBets(roundNumber: number): BotBet[] {
  const count = 10 + Math.floor(Math.random() * 21); // 10-30
  const usedNames = new Set<string>();
  const bets: BotBet[] = [];

  for (let i = 0; i < count; i++) {
    let name: string;
    do {
      name = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
    } while (usedNames.has(name));
    usedNames.add(name);

    const amount = Math.round((1 + Math.random() * 99) * 100) / 100;

    const bet: BotBet = {
      playerId: `bot-${roundNumber}-${i}`,
      amount,
      isBot: true,
      botName: name,
    };

    // 60% chance of auto-cashout
    if (Math.random() < 0.6) {
      bet.autoCashout = Math.round((1.2 + Math.random() * 10) * 100) / 100;
    }

    bets.push(bet);
  }

  return bets;
}
