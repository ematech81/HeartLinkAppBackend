const cloudinary = require('../config/Cloudinary');
const User       = require('../models/User');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/profile-picture
// Upload or replace profile picture
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadProfilePicture = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided.' });
    }

    const imageUrl = req.file.path; // Cloudinary URL

    // Delete old profile picture from Cloudinary if exists
    const user = await User.findById(req.user._id);
    if (user.profilePicture && user.profilePicture.includes('cloudinary')) {
      const publicId = extractPublicId(user.profilePicture);
      if (publicId) {
        await cloudinary.uploader.destroy(publicId).catch(() => {});
      }
    }

    // Update user
    user.profilePicture = imageUrl;
    await user.save({ validateBeforeSave: false });

    console.log(`✅ [Upload] Profile picture updated for ${user._id}`);
    res.status(200).json({ success: true, url: imageUrl, user });

  } catch (error) {
    console.error('❌ [UploadProfilePicture]', error.message);
    res.status(500).json({ success: false, message: 'Upload failed. Please try again.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/photos
// Upload up to 6 gallery photos
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadPhotos = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, message: 'No photos provided.' });
    }

    const user          = await User.findById(req.user._id);
    const currentPhotos = user.photos || [];
    const MAX_PHOTOS    = 6;

    // Check if adding these would exceed the limit
    if (currentPhotos.length + req.files.length > MAX_PHOTOS) {
      // Delete the uploaded files from Cloudinary since we can't use them
      for (const file of req.files) {
        const publicId = extractPublicId(file.path);
        if (publicId) await cloudinary.uploader.destroy(publicId).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: `You can only have ${MAX_PHOTOS} photos total. You currently have ${currentPhotos.length}.`,
      });
    }

    const newUrls  = req.files.map((f) => f.path);
    user.photos    = [...currentPhotos, ...newUrls];
    await user.save({ validateBeforeSave: false });

    console.log(`✅ [Upload] ${newUrls.length} photos added for ${user._id}`);
    res.status(200).json({ success: true, urls: newUrls, photos: user.photos });

  } catch (error) {
    console.error('❌ [UploadPhotos]', error.message);
    res.status(500).json({ success: false, message: 'Photo upload failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/upload/photos/:index
// Delete a specific photo by index
// ─────────────────────────────────────────────────────────────────────────────
exports.deletePhoto = async (req, res) => {
  try {
    const index = parseInt(req.params.index);
    const user  = await User.findById(req.user._id);

    if (!user.photos || index < 0 || index >= user.photos.length) {
      return res.status(400).json({ success: false, message: 'Invalid photo index.' });
    }

    const photoUrl = user.photos[index];

    // Delete from Cloudinary
    const publicId = extractPublicId(photoUrl);
    if (publicId) await cloudinary.uploader.destroy(publicId).catch(() => {});

    // Remove from array
    user.photos.splice(index, 1);
    await user.save({ validateBeforeSave: false });

    res.status(200).json({ success: true, photos: user.photos });

  } catch (error) {
    console.error('❌ [DeletePhoto]', error.message);
    res.status(500).json({ success: false, message: 'Failed to delete photo.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload/video
// Upload intro video (max 30s enforced by Cloudinary)
// ─────────────────────────────────────────────────────────────────────────────
exports.uploadVideo = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file provided.' });
    }

    const videoUrl = req.file.path;

    // Delete old video
    const user = await User.findById(req.user._id);
    if (user.introVideo && user.introVideo.includes('cloudinary')) {
      const publicId = extractPublicId(user.introVideo, 'video');
      if (publicId) await cloudinary.uploader.destroy(publicId, { resource_type: 'video' }).catch(() => {});
    }

    user.introVideo = videoUrl;
    await user.save({ validateBeforeSave: false });

    console.log(`✅ [Upload] Intro video updated for ${user._id}`);
    res.status(200).json({ success: true, url: videoUrl });

  } catch (error) {
    console.error('❌ [UploadVideo]', error.message);
    res.status(500).json({ success: false, message: 'Video upload failed.' });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: extract Cloudinary public_id from URL
// ─────────────────────────────────────────────────────────────────────────────
const extractPublicId = (url, resourceType = 'image') => {
  try {
    // e.g. https://res.cloudinary.com/cloud/image/upload/v123/heartlink/profiles/abc.jpg
    const parts    = url.split('/');
    const uploadIdx = parts.indexOf('upload');
    if (uploadIdx === -1) return null;
    // Skip version segment (v1234567890)
    const afterUpload = parts.slice(uploadIdx + 1);
    const withVersion = afterUpload[0]?.startsWith('v') && /^\d+$/.test(afterUpload[0].slice(1));
    const pathParts   = withVersion ? afterUpload.slice(1) : afterUpload;
    // Remove file extension
    const joined = pathParts.join('/');
    return joined.replace(/\.[^/.]+$/, '');
  } catch {
    return null;
  }
};