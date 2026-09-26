import type { Pool } from 'pg';

// One support thread per player. read_at marks when the *other* side read a
// message: agents read player messages, players read agent replies.

export interface SupportMessage {
  id: number;
  sender: 'player' | 'agent';
  agent: string | null;
  body: string;
  createdAt: string;
  readAt: string | null;
}

export interface SupportThread {
  playerId: string;
  username: string;
  phone: string | null;
  lastMessage: string;
  lastAt: string;
  unreadFromPlayer: number;
}

interface Row {
  id: string;
  sender: string;
  agent: string | null;
  body: string;
  created_at: Date;
  read_at: Date | null;
}

const toMessage = (r: Row): SupportMessage => ({
  id: Number(r.id),
  sender: r.sender as SupportMessage['sender'],
  agent: r.agent,
  body: r.body,
  createdAt: r.created_at.toISOString(),
  readAt: r.read_at?.toISOString() ?? null,
});

export class SupportRepo {
  constructor(private readonly pool: Pool) {}

  async messages(playerId: string): Promise<SupportMessage[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM (SELECT * FROM support_messages WHERE player_id = $1 ORDER BY id DESC LIMIT 200) t ORDER BY id ASC`,
      [playerId],
    );
    return rows.map(toMessage);
  }

  async post(playerId: string, sender: 'player' | 'agent', body: string, agent: string | null = null): Promise<SupportMessage> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO support_messages (player_id, sender, agent, body) VALUES ($1,$2,$3,$4) RETURNING *`,
      [playerId, sender, agent, body],
    );
    return toMessage(rows[0]!);
  }

  /** How many messages this player sent in the last `windowMs`. */
  async recentFromPlayer(playerId: string, windowMs: number, nowMs = Date.now()): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM support_messages WHERE player_id = $1 AND sender = 'player' AND created_at > $2`,
      [playerId, new Date(nowMs - windowMs)],
    );
    return Number(rows[0]!.n);
  }

  /** Mark the other side's messages read by `reader`; returns how many changed. */
  async markRead(playerId: string, reader: 'player' | 'agent'): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE support_messages SET read_at = now() WHERE player_id = $1 AND sender = $2 AND read_at IS NULL`,
      [playerId, reader === 'player' ? 'agent' : 'player'],
    );
    return rowCount ?? 0;
  }

  async unreadForPlayer(playerId: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM support_messages WHERE player_id = $1 AND sender = 'agent' AND read_at IS NULL`,
      [playerId],
    );
    return Number(rows[0]!.n);
  }

  /** Every thread, most recently active first — the support inbox. */
  async threads(limit = 100): Promise<SupportThread[]> {
    const { rows } = await this.pool.query<{
      player_id: string; username: string; phone: string | null; body: string; created_at: Date; unread: string;
    }>(
      `SELECT DISTINCT ON (m.player_id) m.player_id, p.username, p.phone, m.body, m.created_at,
              (SELECT count(*) FROM support_messages u WHERE u.player_id = m.player_id AND u.sender = 'player' AND u.read_at IS NULL)::text AS unread
       FROM support_messages m JOIN players p ON p.player_id = m.player_id
       ORDER BY m.player_id, m.id DESC`,
    );
    return rows
      .map((r) => ({
        playerId: r.player_id,
        username: r.username,
        phone: r.phone,
        lastMessage: r.body,
        lastAt: r.created_at.toISOString(),
        unreadFromPlayer: Number(r.unread),
      }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
      .slice(0, limit);
  }
}
