const { Shipment, SalesOrder, OrderItem, PickList, ProductStock, User, Company, Warehouse, sequelize } = require('../models');
const { Op } = require('sequelize');
const inventoryService = require('./inventoryService');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role !== 'super_admin') where.companyId = reqUser.companyId;
  else if (query.companyId) where.companyId = query.companyId;
  if (query.deliveryStatus) where.deliveryStatus = query.deliveryStatus;
  const shipments = await Shipment.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'SalesOrder', attributes: ['id', 'orderNumber', 'status'], include: ['Client'] },
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'User', attributes: ['id', 'name', 'email'], required: false },
    ],
  });
  return shipments;
}

async function getById(id, reqUser) {
  const shipment = await Shipment.findByPk(id, {
    include: [
      { association: 'SalesOrder', include: ['Client', 'OrderItems'] },
      { association: 'Company' },
      { association: 'User', attributes: { exclude: ['passwordHash'] }, required: false },
    ],
  });
  if (!shipment) throw new Error('Shipment not found');
  if (reqUser.role !== 'super_admin' && shipment.companyId !== reqUser.companyId) throw new Error('Shipment not found');
  return shipment;
}

async function create(data, reqUser) {
  const order = await SalesOrder.findByPk(data.salesOrderId);
  if (!order) throw new Error('Order not found');
  if (order.status !== 'PACKED') throw new Error('Order must be packed first');
  if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');

  const existing = await Shipment.findOne({ where: { salesOrderId: data.salesOrderId } });
  if (existing) throw new Error('This order already has a shipment. Use the existing shipment and update its status (e.g. Mark as Shipped).');

  const shipment = await Shipment.create({
    salesOrderId: order.id,
    companyId: order.companyId,
    packedBy: reqUser.id,
    courierName: data.courierName || null,
    trackingNumber: data.trackingNumber || null,
    weight: data.weight || null,
    dispatchDate: data.dispatchDate || new Date().toISOString().slice(0, 10),
    deliveryStatus: 'READY_TO_SHIP',
  });

  // Requirement: READY_TO_SHIP -> Sales Order = PACKED (No change needed)
  await order.update({ status: 'PACKED' });

  return getById(shipment.id, reqUser);
}

async function update(id, data, reqUser) {
  const shipment = await Shipment.findByPk(id);
  if (!shipment) throw new Error('Shipment not found');
  if (reqUser.role !== 'super_admin' && shipment.companyId !== reqUser.companyId) throw new Error('Shipment not found');

  const oldStatus = (shipment.deliveryStatus || '').toUpperCase();
  const newStatus = (data.deliveryStatus ?? shipment.deliveryStatus ?? '').toUpperCase();
  const becomesShippedOrDelivered = ['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(newStatus) && !['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(oldStatus);

  await shipment.update({
    courierName: data.courierName ?? shipment.courierName,
    trackingNumber: data.trackingNumber ?? shipment.trackingNumber,
    weight: data.weight !== undefined ? data.weight : shipment.weight,
    dispatchDate: data.dispatchDate ?? shipment.dispatchDate,
    deliveryStatus: data.deliveryStatus ?? shipment.deliveryStatus,
  });

  const order = await SalesOrder.findByPk(shipment.salesOrderId);
  if (!order) return getById(id, reqUser);

  if (data.deliveryStatus === 'SHIPPED' || data.deliveryStatus === 'IN_TRANSIT') {
    await order.update({ status: 'SHIPPED' });
  } else if (data.deliveryStatus === 'DELIVERED') {
    await order.update({ status: 'COMPLETED' });
  } else if (data.deliveryStatus === 'FAILED' || data.deliveryStatus === 'RETURNED') {
    await order.update({ status: 'SHIPPED' });
  }

  // Shipped/Delivered hone ke baad inventory & product stock se quantity minus (sirf ek hi bar)
    const t = await sequelize.transaction();
    try {
      const orderItems = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
      const pickList = await PickList.findOne({ where: { salesOrderId: order.id }, attributes: ['warehouseId'], transaction: t });
      const warehouseId = pickList?.warehouseId;

      if (!warehouseId) throw new Error('Cannot deduct stock: No warehouse associated with this order picklist');

      for (const item of orderItems) {
        await inventoryService.shipStock({
          productId: item.productId,
          companyId: order.companyId,
          warehouseId,
          clientId: order.customerId || null,
          quantity: item.quantity,
          referenceId: `SHIP:${shipment.id}`,
          userId: reqUser.id
        }, t);
      }

      await shipment.update({ stockDeducted: true }, { transaction: t });
      await t.commit();
    } catch (err) {
      await t.rollback();
      console.error('Shipment stock deduct failed:', err.message);
    }

  return getById(id, reqUser);
}

async function deductStockForShipment(shipmentId, reqUser) {
  const shipment = await Shipment.findByPk(Number(shipmentId) || shipmentId);
  if (!shipment) throw new Error('Shipment not found');
  if (reqUser.role !== 'super_admin' && shipment.companyId !== reqUser.companyId) throw new Error('Shipment not found');

  if (shipment.stockDeducted) {
    throw new Error('Stock already deducted for this shipment');
  }

  const st = (shipment.deliveryStatus || '').toUpperCase();
  if (!['SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(st)) throw new Error('Only shipped/delivered shipments can deduct stock');

  const order = await SalesOrder.findByPk(shipment.salesOrderId);
  if (!order) throw new Error('Order not found');

  const t = await sequelize.transaction();
  try {
    const orderItems = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
    const pickList = await PickList.findOne({ where: { salesOrderId: order.id }, attributes: ['warehouseId'], transaction: t });
    const warehouseId = pickList?.warehouseId;

    if (!warehouseId) throw new Error('No warehouse associated with this order picklist');

    for (const item of orderItems) {
      await inventoryService.shipStock({
        productId: item.productId,
        companyId: order.companyId,
        warehouseId,
        clientId: order.customerId || null,
        quantity: item.quantity,
        referenceId: `SHIP:${shipment.id}`,
        userId: reqUser.id
      }, t);
    }

    await shipment.update({ stockDeducted: true }, { transaction: t });
    await t.commit();
    return { message: 'Stock successfully deducted for this shipment.', success: true };
  } catch (err) {
    await t.rollback();
    throw err;
  }

  return { message: deducted > 0 ? `Stock deducted for ${deducted} product(s). Refresh Inventory/Products.` : 'No stock records found. Ensure products have inventory (Stock).', deducted };
}

module.exports = { list, getById, create, update, deductStockForShipment };
