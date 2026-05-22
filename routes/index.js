const express = require('express');
const router = express.Router();
const authRoutes = require('./auth');
const superadminRoutes = require('../modules/superadmin/routes');
const superadminController = require('../controllers/superadminController');
const { authenticate, requireSuperAdmin, requireRole } = require('../middlewares/auth');
const companyRoutes = require('../modules/company/routes');
const userRoutes = require('../modules/users/routes');
const warehouseRoutes = require('./warehouses');
const zoneRoutes = require('./zones');
const locationRoutes = require('./locations');
const supplierRoutes = require('./suppliers');
const supplierProductRoutes = require('./supplierProducts');
const bundleRoutes = require('./bundles');
const inventoryRoutes = require('../modules/inventory/routes');
const orderRoutes = require('../modules/orders/routes');
const pickingRoutes = require('../modules/picking/routes');
const packingRoutes = require('../modules/packing/routes');
const shipmentRoutes = require('../modules/shipment/routes');
const purchaseOrderRoutes = require('./purchaseOrders');
const goodsReceivingRoutes = require('./goodsReceiving');
const replenishmentRoutes = require('./replenishment');
const returnRoutes = require('./returnRoutes');
const vatCodeRoutes = require('./vatCodeRoutes');
const labelsController = require('../controllers/labelsController');
const searchController = require('../controllers/searchController');

router.use('/auth', authRoutes);
router.use('/api/auth', authRoutes); // Add /api prefix for consistency
const searchRoles = ['super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'viewer', 'picker', 'packer'];
router.get('/api/search', authenticate, requireRole(...searchRoles), searchController.search);
router.get('/api/labels', authenticate, requireRole('super_admin', 'company_admin', 'warehouse_manager', 'inventory_manager', 'packer', 'viewer'), labelsController.list);
// Super admin stats & reports (explicit so 404 doesn't happen)
router.get('/api/superadmin/stats', authenticate, requireSuperAdmin, superadminController.stats);
router.get('/api/superadmin/reports', authenticate, requireSuperAdmin, superadminController.reports);
router.use('/api/superadmin', superadminRoutes);
router.use('/api/company', companyRoutes);
router.use('/api/users', userRoutes);
router.use('/api/warehouses', warehouseRoutes);
router.use('/api/zones', zoneRoutes);
router.use('/api/locations', locationRoutes);
router.use('/api/suppliers', supplierRoutes);
router.use('/api/supplier-products', supplierProductRoutes);
router.use('/api/bundles', bundleRoutes);
router.use('/api/inventory', inventoryRoutes);
router.use('/api/orders', orderRoutes);
router.use('/api/picking', pickingRoutes);
router.use('/api/packing', packingRoutes);
router.use('/api/shipments', shipmentRoutes);
router.use('/api/purchase-orders', purchaseOrderRoutes);
router.use('/api/goods-receiving', goodsReceivingRoutes);
router.use('/api/replenishment', replenishmentRoutes);
router.use('/api/returns', returnRoutes);
router.use('/api/vat-codes', vatCodeRoutes);
const multer = require('multer');
const path = require('path');
let cloudinary;
try {
  cloudinary = require('cloudinary').v2;
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
} catch (err) {
  console.error('WARNING: Cloudinary module not found. Image uploads will fail. Run "npm install cloudinary" to fix.');
}

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|gif/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (mimetype && extname) return cb(null, true);
    cb(new Error('Only image files (jpg, jpeg, png, gif) are allowed!'));
  }
});

router.post('/api/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    if (!cloudinary) {
      return res.status(500).json({ success: false, message: 'Cloudinary module not installed. Please run "npm install cloudinary" on the server.' });
    }
    
    // Upload to Cloudinary using buffer
    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { folder: 'wms_uploads' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      uploadStream.end(req.file.buffer);
    });

    res.json({ success: true, data: { url: result.secure_url } });
  } catch (err) {
    console.error('Cloudinary Upload Error:', err);
    res.status(500).json({ success: false, message: 'Upload to Cloudinary failed' });
  }
});


module.exports = router;
