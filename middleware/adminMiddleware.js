const { protect } = require('./authMiddleware');

const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required' });
  }
  next();
};

// Compose protect + adminOnly so routes only need one middleware array
exports.adminProtect = [protect, adminOnly];
