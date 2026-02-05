import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { pool } from '../db/pool.js';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { getStorageProvider } from '../services/storage/factory.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/flac', 'audio/mp3', 'audio/x-wav', 'audio/x-flac'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(mp3|wav|flac)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP3, WAV, and FLAC are allowed.'));
    }
  }
});

// Get user's reference tracks
router.get('/', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT id, filename, storage_key, duration, file_size_bytes, tags, created_at
       FROM reference_tracks
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user!.id]
    );

    const storage = getStorageProvider();
    const tracks = result.rows.map(row => ({
      ...row,
      audio_url: storage.getPublicUrl(row.storage_key)
    }));

    res.json({ tracks });
  } catch (error) {
    console.error('Get reference tracks error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Upload a new reference track
router.post('/', authMiddleware, upload.single('audio'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }

    const userId = req.user!.id;
    const originalFilename = req.file.originalname;
    const ext = path.extname(originalFilename) || '.mp3';
    const timestamp = Date.now();
    const key = `reference-tracks/${userId}/${timestamp}${ext}`;

    const storage = getStorageProvider();
    await storage.upload(key, req.file.buffer, req.file.mimetype);
    const audioUrl = storage.getPublicUrl(key);

    // Parse tags from request body if provided
    const tags = req.body.tags ? JSON.parse(req.body.tags) : null;

    const result = await pool.query(
      `INSERT INTO reference_tracks (user_id, filename, storage_key, file_size_bytes, tags)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, originalFilename, key, req.file.size, tags]
    );

    res.status(201).json({
      track: {
        ...result.rows[0],
        audio_url: audioUrl
      }
    });
  } catch (error) {
    console.error('Upload reference track error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: 'Failed to upload reference track', details: errorMessage });
  }
});

// Update reference track (duration, tags)
router.patch('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify ownership
    const check = await pool.query(
      'SELECT user_id FROM reference_tracks WHERE id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const { duration, tags } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramCount = 1;

    if (duration !== undefined) {
      updates.push(`duration = $${paramCount}`);
      values.push(duration);
      paramCount++;
    }
    if (tags !== undefined) {
      updates.push(`tags = $${paramCount}`);
      values.push(tags);
      paramCount++;
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No fields to update' });
      return;
    }

    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE reference_tracks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
      values
    );

    const storage = getStorageProvider();
    res.json({
      track: {
        ...result.rows[0],
        audio_url: storage.getPublicUrl(result.rows[0].storage_key)
      }
    });
  } catch (error) {
    console.error('Update reference track error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete a reference track
router.delete('/:id', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Verify ownership
    const check = await pool.query(
      'SELECT user_id, storage_key FROM reference_tracks WHERE id = $1',
      [req.params.id]
    );
    if (check.rows.length === 0) {
      res.status(404).json({ error: 'Track not found' });
      return;
    }
    if (check.rows[0].user_id !== req.user!.id) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    // Delete from storage
    const storage = getStorageProvider();
    try {
      await storage.delete(check.rows[0].storage_key);
    } catch (storageError) {
      console.error('Failed to delete from storage:', storageError);
    }

    // Delete from database
    await pool.query('DELETE FROM reference_tracks WHERE id = $1', [req.params.id]);

    res.json({ success: true });
  } catch (error) {
    console.error('Delete reference track error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
