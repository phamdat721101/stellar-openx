/**
 * knowledge-ingest — minimal plaintext storage for agent context.
 *
 * v3.0.0 scope: agents store plaintext knowledge chunks tied to their agent
 * id. No FHE encryption, no Fhenix-wrapped keys; the chunks live in
 * Supabase, retrieved per inference call.
 *
 * SOLID: one class, three methods; no providers / no chain reads.
 */

import { pool } from '../db';

const CHUNK_SIZE = 1_500;

export class KnowledgeIngestService {
  static async ingest(
    ownerAddress: string,
    content: string,
    agentId: string | null,
  ): Promise<{ agent_id: string; chunks: number }> {
    if (!agentId) {
      throw new Error('agentId is required (v3.0.0 stores knowledge per agent)');
    }
    const owns = await pool.query(
      `SELECT 1 FROM agents WHERE id = $1 AND owner_address = $2`,
      [agentId, ownerAddress],
    );
    if (owns.rowCount === 0) throw new Error('not_owner');
    const chunks = this.split(content);
    const existingMax = await pool.query<{ max: number }>(
      `SELECT COALESCE(MAX(chunk_index), -1) AS max FROM knowledge_chunks WHERE agent_id = $1`,
      [agentId],
    );
    let idx = (existingMax.rows[0]?.max ?? -1) + 1;
    for (const c of chunks) {
      await pool.query(
        `INSERT INTO knowledge_chunks (agent_id, chunk_index, content) VALUES ($1, $2, $3)`,
        [agentId, idx, c],
      );
      idx += 1;
    }
    return { agent_id: agentId, chunks: chunks.length };
  }

  static async loadChunks(agentId: string, limit = 50): Promise<string[]> {
    try {
      const r = await pool.query<{ content: string }>(
        `SELECT content FROM knowledge_chunks WHERE agent_id = $1
          ORDER BY chunk_index ASC LIMIT $2`,
        [agentId, limit],
      );
      return r.rows.map((row) => row.content);
    } catch {
      // Schema may not have the knowledge_chunks table yet (v3.0.0 demo
      // deployments). Treat as "no knowledge attached" — inference proceeds.
      return [];
    }
  }

  private static split(text: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      out.push(text.slice(i, i + CHUNK_SIZE));
    }
    return out;
  }
}
