const { InventoryLog, Product } = require('./models');

async function test() {
  try {
    const logs = await InventoryLog.findAll({
      limit: 5,
      order: [['createdAt', 'DESC']],
      include: [{ model: Product, attributes: ['name', 'sku'] }]
    });
    console.log('Recent Logs:');
    logs.forEach(l => {
      console.log(`${l.createdAt} - ${l.type} - Qty: ${l.quantity} - Product: ${l.Product?.sku} - Reason: ${l.reason}`);
    });
    process.exit(0);
  } catch (err) {
    console.error('DB Error:', err.message);
    process.exit(1);
  }
}

test();
