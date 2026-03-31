const multer        = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary    = require('./Cloudinary');

// ── Profile picture storage ───────────────────────────────────────────────────
const profileStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         'heartlink/profiles',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      { width: 800, height: 1000, crop: 'limit', quality: 'auto' },
    ],
    overwrite: false,
  },
});

// ── Gallery photos storage ────────────────────────────────────────────────────
const photoStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:         'heartlink/photos',
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp'],
    transformation: [
      { width: 1080, height: 1350, crop: 'limit', quality: 'auto' },
    ],
    overwrite: false,
  },
});

// ── Video storage ─────────────────────────────────────────────────────────────
const videoStorage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    resource_type:   'video',
    folder:          'heartlink/videos',
    allowed_formats: ['mp4', 'mov', 'avi', 'webm'],
    transformation:  [
      { duration: '30', crop: 'limit' }, // max 30 seconds
      { quality: 'auto' },
    ],
    overwrite: false,
  }),
});

// ── File size limits ──────────────────────────────────────────────────────────
const imageFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};

const videoFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('video/')) cb(null, true);
  else cb(new Error('Only video files are allowed'), false);
};

// ── Exported multer instances ─────────────────────────────────────────────────
const uploadProfilePicture = multer({
  storage:  profileStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
}).single('profilePicture');

const uploadPhotos = multer({
  storage:  photoStorage,
  fileFilter: imageFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
}).array('photos', 6); // max 6 photos

const uploadVideo = multer({
  storage:  videoStorage,
  fileFilter: videoFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
}).single('video');

module.exports = { uploadProfilePicture, uploadPhotos, uploadVideo };