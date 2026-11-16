'use strict';

/**
 * Modelo del buzón de comentarios, mejoras y problemas, y de los puntos de fidelidad (IMPLEMENTATION.md → «Modelo de datos»).
 *
 * - Personas y organizaciones son ids de auth-service: sin FOREIGN KEY entre servicios. Nombre y correo se copian al crear.
 * - Los puntos son un libro de movimientos (nunca un saldo editable). `idempotency_key` UNIQUE: un doble clic no los da dos veces.
 * - `outbox_messages` con la forma de @facturero/outbox-relay.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const id = { type: Sequelize.CHAR(36), allowNull: false };

    await queryInterface.createTable('feedback_items', {
      id: { ...id, primaryKey: true },
      organization_id: id,
      organization_name: { type: Sequelize.STRING(160), allowNull: true },
      author_id: id,
      author_name: { type: Sequelize.STRING(200), allowNull: true },
      author_email: { type: Sequelize.STRING(255), allowNull: true },
      kind: { type: Sequelize.ENUM('improvement', 'comment', 'problem'), allowNull: false },
      title: { type: Sequelize.STRING(160), allowNull: false },
      body: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.ENUM('new', 'reviewing', 'accepted', 'implemented', 'declined'), allowNull: false, defaultValue: 'new' },
      trace_id: { type: Sequelize.STRING(64), allowNull: true },
      url_path: { type: Sequelize.STRING(300), allowNull: true },
      unread_by_platform: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      unread_by_author: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      reply_count: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      last_activity_at: { type: Sequelize.DATE, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('feedback_items', ['organization_id', 'author_id', 'last_activity_at'], { name: 'ix_feedback_author' });
    await queryInterface.addIndex('feedback_items', ['last_activity_at'], { name: 'ix_feedback_activity' });
    await queryInterface.addIndex('feedback_items', ['status', 'last_activity_at'], { name: 'ix_feedback_status' });

    await queryInterface.createTable('feedback_replies', {
      id: { ...id, primaryKey: true },
      item_id: { ...id, references: { model: 'feedback_items', key: 'id' }, onDelete: 'CASCADE' },
      author_id: id,
      from_platform: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      body: { type: Sequelize.TEXT, allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('feedback_replies', ['item_id', 'created_at'], { name: 'ix_replies_item' });

    await queryInterface.createTable('points_entries', {
      id: { ...id, primaryKey: true },
      organization_id: id,
      item_id: { type: Sequelize.CHAR(36), allowNull: true },
      amount: { type: Sequelize.INTEGER, allowNull: false },
      reason: { type: Sequelize.STRING(200), allowNull: false },
      granted_by: id,
      idempotency_key: { type: Sequelize.STRING(64), allowNull: false },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('points_entries', ['idempotency_key'], { unique: true, name: 'uq_points_idempotency' });
    await queryInterface.addIndex('points_entries', ['organization_id', 'created_at'], { name: 'ix_points_org' });
    await queryInterface.addIndex('points_entries', ['item_id'], { name: 'ix_points_item' });

    await queryInterface.createTable('outbox_messages', {
      id: { ...id, primaryKey: true },
      aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
      aggregate_id: id,
      type: { type: Sequelize.STRING(100), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      occurred_at: { type: Sequelize.DATE, allowNull: false },
      processed_at: { type: Sequelize.DATE, allowNull: true },
    });
    await queryInterface.addIndex('outbox_messages', ['processed_at']);
  },

  async down(queryInterface) {
    for (const table of ['outbox_messages', 'points_entries', 'feedback_replies', 'feedback_items']) await queryInterface.dropTable(table);
  },
};
