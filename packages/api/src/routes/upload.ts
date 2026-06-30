import { Router, type Request } from 'express';
import multer from 'multer';
import { auth, type AuthRequest } from '../middleware/auth';
import { KnowledgeIngestService } from '../services/knowledge-ingest';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.use(auth);

/** Upload a knowledge file. Plaintext only in v3.0.0 (FHE encryption removed). */
router.post('/', upload.single('file'), async (req: Request, res) => {
  const authReq = req as AuthRequest;
  const file = (req as Request & { file?: { buffer: Buffer; originalname: string } }).file;
  if (!file) return res.status(400).json({ error: 'No file provided' });
  if (!authReq.user) return res.status(401).json({ error: 'auth required' });
  const agentId = req.body.agentId ?? null;
  const content = file.buffer.toString('utf-8');
  const result = await KnowledgeIngestService.ingest(authReq.user.address, content, agentId);
  res.json(result);
});

export default router;
