const express  = require('express');
const router   = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  uploadProfilePicture,
  uploadPhotos,
  uploadVideo,
} = require('../config/multer');
const ctrl = require('../controllers/uploadController');

// ── Multer error handler wrapper ─────────────────────────────────────────────
const handleUpload = (multerFn) => (req, res, next) => {
  multerFn(req, res, (err) => {
    if (err) {
      console.error('Multer error:', err.message);
      return res.status(400).json({ success: false, message: err.message });
    }
    next();
  });
};

// ── Routes ────────────────────────────────────────────────────────────────────
// POST   /api/upload/profile-picture  — upload/replace profile picture
// POST   /api/upload/photos           — upload up to 6 gallery photos
// DELETE /api/upload/photos/:index    — delete a gallery photo by index
// POST   /api/upload/video            — upload 30s intro video

router.post(
  '/profile-picture',
  protect,
  handleUpload(uploadProfilePicture),
  ctrl.uploadProfilePicture
);

router.post(
  '/photos',
  protect,
  handleUpload(uploadPhotos),
  ctrl.uploadPhotos
);

router.delete(
  '/photos/:index',
  protect,
  ctrl.deletePhoto
);

router.post(
  '/video',
  protect,
  handleUpload(uploadVideo),
  ctrl.uploadVideo
);

module.exports = router;