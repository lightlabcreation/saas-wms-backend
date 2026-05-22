const { SalesOrder, OrderItem, Product, Customer, Company, PickList, PickListItem, PackingTask, Warehouse, Shipment, ProductStock, sequelize } = require('../models');
const { Op } = require('sequelize');
const inventoryService = require('./inventoryService');

async function list(reqUser, query = {}) {
  const where = {};
  if (reqUser.role === 'super_admin') {
    if (query.companyId) where.companyId = query.companyId;
  } else {
    where.companyId = reqUser.companyId;
  }
  if (query.status) where.status = query.status;
  const orders = await SalesOrder.findAll({
    where,
    order: [['createdAt', 'DESC']],
    include: [
      { association: 'Company', attributes: ['id', 'name', 'code'] },
      { association: 'Client', attributes: ['id', 'name', 'email', 'address', 'city', 'state', 'country', 'postcode'] },
      { association: 'OrderItems', include: [{ association: 'Product', attributes: ['id', 'name', 'sku', 'weight', 'weightUnit'] }, { association: 'Warehouse', attributes: ['id', 'name'] }] },
      { association: 'PickLists', include: [{ association: 'PickListItems', include: [{ association: 'Product' }] }] },
      { association: 'Shipment' },
    ],
  });
  return orders.map((o) => o.get({ plain: true }));
}

async function getById(id, reqUser) {
  const order = await SalesOrder.findByPk(id, {
    include: [
      { association: 'Company' },
      { association: 'Client' },
      { association: 'OrderItems', include: ['Product', 'Warehouse'] },
      { association: 'PickLists', include: ['PickListItems', 'Warehouse', 'User'] },
      { association: 'PackingTasks', include: ['User'] },
      { association: 'Shipment' },
    ],
  });
  if (!order) throw new Error('Order not found');
  if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');
  return order;
}

async function create(data, reqUser) {
  if (reqUser.role !== 'super_admin' && reqUser.role !== 'company_admin') throw new Error('Only Company Admin can create sales orders');
  const companyId = reqUser.companyId;

  const t = await sequelize.transaction();
  try {
    const count = await SalesOrder.count({ where: { companyId }, transaction: t });
    const orderNumber = `ORD-${Date.now()}-${String(count + 1).padStart(4, '0')}`;

    const order = await SalesOrder.create({
      companyId,
      orderNumber,
      customerId: data.customerId || null,
      orderDate: data.orderDate || null,
      requiredDate: data.requiredDate || null,
      priority: data.priority || 'MEDIUM',
      salesChannel: data.salesChannel || 'DIRECT',
      orderType: data.orderType || null,
      referenceNumber: data.referenceNumber || null,
      notes: data.notes || null,
      status: 'DRAFT',
      totalAmount: 0,
      createdBy: reqUser.id,
    }, { transaction: t });

    let total = 0;
    const warehouse = await Warehouse.findOne({ where: { companyId }, transaction: t });

    if (data.items && data.items.length) {
      for (const row of data.items) {
        const product = await Product.findByPk(row.productId, { transaction: t });
        if (!product || product.companyId !== companyId) continue;

        const unitPrice = row.unitPrice ?? product.price;
        const qty = row.quantity || 1;

        // RESERVE STOCK
        // We prioritize the warehouse selected by the user (row.warehouseId).
        let targetWarehouseId = row.warehouseId;

        if (targetWarehouseId) {
          // Verify stock in selected warehouse
          const hasStockInSelected = await ProductStock.findOne({
            where: {
              productId: product.id,
              warehouseId: targetWarehouseId,
              companyId,
              quantity: { [Op.gt]: sequelize.col('reserved') }
            },
            transaction: t
          });
          if (!hasStockInSelected) {
            throw new Error(`Insufficient available stock for product ${product.sku} in selected warehouse.`);
          }
        } else {
          // No warehouse selected, try default warehouse
          targetWarehouseId = warehouse?.id;
          const hasStockInDefault = targetWarehouseId ? await ProductStock.findOne({
            where: {
              productId: product.id,
              warehouseId: targetWarehouseId,
              companyId,
              quantity: { [Op.gt]: sequelize.col('reserved') }
            },
            transaction: t
          }) : null;

          if (!hasStockInDefault) {
            // Try ANY warehouse
            const otherWh = await ProductStock.findOne({
              where: {
                productId: product.id,
                companyId,
                quantity: { [Op.gt]: sequelize.col('reserved') }
              },
              transaction: t
            });
            if (otherWh) {
              targetWarehouseId = otherWh.warehouseId;
            } else {
              throw new Error(`Insufficient available stock for product ${product.sku} across all warehouses.`);
            }
          }
        }

        await OrderItem.create({
          salesOrderId: order.id,
          productId: product.id,
          quantity: qty,
          unitPrice: unitPrice,
          warehouseId: targetWarehouseId,
        }, { transaction: t });

        total += Number(unitPrice) * qty;

        if (targetWarehouseId) {
          await inventoryService.reserveStock({
            productId: product.id,
            companyId,
            warehouseId: targetWarehouseId,
            quantity: qty
          }, t);
        } else {
          throw new Error(`Insufficient available stock for product ${product.sku} across all warehouses.`);
        }
      }
      await order.update({ totalAmount: total }, { transaction: t });
    }

    // 5. Create PickLists for each warehouse involved
    const orderItemsForPick = await OrderItem.findAll({ where: { salesOrderId: order.id }, transaction: t });
    const warehouseGroups = {};
    orderItemsForPick.forEach(item => {
      if (!warehouseGroups[item.warehouseId]) warehouseGroups[item.warehouseId] = [];
      warehouseGroups[item.warehouseId].push(item);
    });

    for (const whId in warehouseGroups) {
      const pickList = await PickList.create({
        salesOrderId: order.id,
        warehouseId: whId,
        status: 'NOT_STARTED',
      }, { transaction: t });

      for (const item of warehouseGroups[whId]) {
        await PickListItem.create({
          pickListId: pickList.id,
          productId: item.productId,
          quantityRequired: item.quantity,
          quantityPicked: 0,
        }, { transaction: t });
      }
      // Also create a PackingTask for this PickList
      await PackingTask.create({
        salesOrderId: order.id,
        pickListId: pickList.id,
        status: 'NOT_STARTED',
      }, { transaction: t });
    }

    await order.update({ status: 'CONFIRMED' }, { transaction: t });

    await t.commit();
    return getById(order.id, reqUser);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function update(id, data, reqUser) {
  const t = await sequelize.transaction();
  try {
    const order = await SalesOrder.findByPk(id, {
      include: [{ association: 'OrderItems' }, { association: 'PickLists' }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!order) throw new Error('Order not found');
    if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');

    const allowedStatuses = ['DRAFT', 'CONFIRMED'];
    if (!allowedStatuses.includes((order.status || '').toUpperCase())) {
      throw new Error('Only DRAFT or CONFIRMED orders can be edited');
    }

    // 1. Unreserve OLD items (if a warehouse was assigned)
    const warehouseId = order.PickLists?.[0]?.warehouseId;
    if (warehouseId && order.OrderItems) {
      for (const item of order.OrderItems) {
        await inventoryService.unreserveStock({
          productId: item.productId,
          companyId: order.companyId,
          warehouseId,
          clientId: order.customerId || null,
          quantity: item.quantity
        }, t);
      }
    }

    // 2. Update Order Details
    await order.update({
      customerId: data.customerId !== undefined ? data.customerId : order.customerId,
      orderDate: data.orderDate !== undefined ? data.orderDate : order.orderDate,
      requiredDate: data.requiredDate !== undefined ? data.requiredDate : order.requiredDate,
      priority: data.priority !== undefined ? data.priority : order.priority,
      salesChannel: data.salesChannel !== undefined ? data.salesChannel : order.salesChannel,
      orderType: data.orderType !== undefined ? data.orderType : order.orderType,
      referenceNumber: data.referenceNumber !== undefined ? data.referenceNumber : order.referenceNumber,
      notes: data.notes !== undefined ? data.notes : order.notes,
    }, { transaction: t });

    // 3. Update Items & Reserve NEW ones
    if (data.items && Array.isArray(data.items)) {
      await OrderItem.destroy({ where: { salesOrderId: order.id }, transaction: t });
      let total = 0;

      const currentWarehouse = await Warehouse.findOne({ where: { companyId: order.companyId }, transaction: t });

      for (const row of data.items) {
        const product = await Product.findByPk(row.productId, { transaction: t });
        if (!product || product.companyId !== order.companyId) continue;

        const unitPrice = row.unitPrice ?? product.price;
        const qty = row.quantity || 1;

        await OrderItem.create({
          salesOrderId: order.id,
          productId: product.id,
          quantity: qty,
          unitPrice: unitPrice,
        }, { transaction: t });

        total += Number(unitPrice) * qty;

        // Re-reserve
        if (currentWarehouse) {
          await inventoryService.reserveStock({
            productId: product.id,
            companyId: order.companyId,
            warehouseId: currentWarehouse.id,
            clientId: order.customerId || null,
            quantity: qty
          }, t);
        }
      }
      await order.update({ totalAmount: total }, { transaction: t });
    }

    await t.commit();
    return getById(order.id, reqUser);
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

async function remove(id, reqUser) {
  const t = await sequelize.transaction();
  try {
    const order = await SalesOrder.findByPk(id, {
      include: [{ association: 'OrderItems' }, { association: 'PickLists' }],
      transaction: t,
      lock: t.LOCK.UPDATE
    });
    if (!order) throw new Error('Order not found');
    if (reqUser.role !== 'super_admin' && order.companyId !== reqUser.companyId) throw new Error('Order not found');

    const allowedStatuses = ['DRAFT', 'CONFIRMED', 'PICK_LIST_CREATED'];
    const status = (order.status || '').toUpperCase();
    if (!allowedStatuses.includes(status)) {
      throw new Error(`This sales order cannot be deleted. Current status: ${status || 'Unknown'}. Only Draft, Confirmed or Pick list created orders can be deleted.`);
    }

    // UNRESERVE STOCK
    const warehouseId = order.PickLists?.[0]?.warehouseId;
    if (warehouseId && order.OrderItems) {
      for (const item of order.OrderItems) {
        await inventoryService.unreserveStock({
          productId: item.productId,
          companyId: order.companyId,
          warehouseId,
          clientId: order.customerId || null,
          quantity: item.quantity
        }, t);
      }
    }

    await OrderItem.destroy({ where: { salesOrderId: order.id }, transaction: t });
    const pickLists = await PickList.findAll({ where: { salesOrderId: order.id }, transaction: t });
    for (const pl of pickLists) {
      await PickListItem.destroy({ where: { pickListId: pl.id }, transaction: t });
      await PackingTask.destroy({ where: { pickListId: pl.id }, transaction: t });
      await pl.destroy({ transaction: t });
    }
    await PackingTask.destroy({ where: { salesOrderId: order.id }, transaction: t });
    await Shipment.destroy({ where: { salesOrderId: order.id }, transaction: t });
    await order.destroy({ transaction: t });

    await t.commit();
    return { message: 'Order deleted and stock unreserved' };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

module.exports = { list, getById, create, update, remove };
