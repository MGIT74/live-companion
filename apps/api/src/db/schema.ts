/**
 * Schéma MySQL de Live Companion (Drizzle ORM).
 *
 * Conventions :
 *  - clés primaires ULID (char 26) : non devinables, triables par date ;
 *  - montants en ariary, entiers (int) ;
 *  - toute table métier porte shop_id : l'isolation entre boutiques est vérifiée
 *    dans chaque requête (voir lib/tenant.ts) ;
 *  - horodatages UTC.
 */
import { relations, sql } from 'drizzle-orm';
import {
  bigint, boolean, char, datetime, index, int, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar,
} from 'drizzle-orm/mysql-core';

const id = () => char('id', { length: 26 }).primaryKey();
const shopId = () => char('shop_id', { length: 26 }).notNull();
const createdAt = () => datetime('created_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`);
const updatedAt = () => datetime('updated_at', { mode: 'date', fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdate(() => new Date());

// ---------------------------------------------------------------- Identité et boutiques
export const users = mysqlTable('users', {
  id: id(),
  email: varchar('email', { length: 191 }).notNull(),
  phone: varchar('phone', { length: 20 }),
  passwordHash: varchar('password_hash', { length: 100 }).notNull(),
  fullName: varchar('full_name', { length: 120 }).notNull(),
  locale: varchar('locale', { length: 5 }).notNull().default('fr'),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

export const shops = mysqlTable('shops', {
  id: id(),
  slug: varchar('slug', { length: 80 }).notNull(),
  name: varchar('name', { length: 120 }).notNull(),
  city: varchar('city', { length: 80 }),
  phone: varchar('phone', { length: 20 }),
  status: mysqlEnum('status', ['ACTIVE', 'SUSPENDED', 'CLOSED']).notNull().default('ACTIVE'),
  reservationTtlMinutes: int('reservation_ttl_minutes').notNull().default(1440),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('shops_slug_uq').on(t.slug)]);

export const SHOP_ROLES = ['OWNER', 'MANAGER', 'LIVE_ASSISTANT', 'SALES'] as const;
export type ShopRole = (typeof SHOP_ROLES)[number];

export const shopMembers = mysqlTable('shop_members', {
  id: id(),
  shopId: shopId(),
  userId: char('user_id', { length: 26 }).notNull(),
  role: mysqlEnum('role', SHOP_ROLES).notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('shop_members_uq').on(t.shopId, t.userId), index('shop_members_user_idx').on(t.userId)]);

// ---------------------------------------------------------------- Clients (CRM)
export const customers = mysqlTable('customers', {
  id: id(),
  shopId: shopId(),
  fullName: varchar('full_name', { length: 120 }),
  phone: varchar('phone', { length: 20 }),
  email: varchar('email', { length: 191 }),
  address: varchar('address', { length: 255 }),
  city: varchar('city', { length: 80 }),
  fbUserId: varchar('fb_user_id', { length: 40 }),     // auteur des commentaires (id propre à l'app)
  messengerPsid: varchar('messenger_psid', { length: 40 }), // id Messenger propre à la Page
  notes: text('notes'),
  tags: json('tags').$type<string[]>(),
  isBlocked: boolean('is_blocked').notNull().default(false),
  cancelCount: int('cancel_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('customers_shop_phone_uq').on(t.shopId, t.phone),
  index('customers_shop_fb_idx').on(t.shopId, t.fbUserId),
  index('customers_shop_psid_idx').on(t.shopId, t.messengerPsid),
  index('customers_shop_name_idx').on(t.shopId, t.fullName),
]);

// ---------------------------------------------------------------- Catalogue et stock
export const products = mysqlTable('products', {
  id: id(),
  shopId: shopId(),
  code: varchar('code', { length: 12 }).notNull(),
  name: varchar('name', { length: 160 }).notNull(),
  description: text('description'),
  priceMga: int('price_mga').notNull(),
  isPublished: boolean('is_published').notNull().default(true),
  archivedAt: datetime('archived_at', { mode: 'date' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex('products_shop_code_uq').on(t.shopId, t.code)]);

export const productVariants = mysqlTable('product_variants', {
  id: id(),
  shopId: shopId(),
  productId: char('product_id', { length: 26 }).notNull(),
  label: varchar('label', { length: 60 }).notNull(),
  priceMga: int('price_mga'), // surcharge éventuelle du prix produit
  stockOnHand: int('stock_on_hand').notNull().default(0),
  reserved: int('reserved').notNull().default(0), // invariant : 0 <= reserved <= stock_on_hand
  createdAt: createdAt(),
}, (t) => [uniqueIndex('variants_product_label_uq').on(t.productId, t.label), index('variants_shop_idx').on(t.shopId)]);

export const productImages = mysqlTable('product_images', {
  id: id(),
  shopId: shopId(),
  productId: char('product_id', { length: 26 }).notNull(),
  url: varchar('url', { length: 500 }).notNull(),
  position: int('position').notNull().default(0),
});

export const inventoryMovements = mysqlTable('inventory_movements', {
  id: id(),
  shopId: shopId(),
  variantId: char('variant_id', { length: 26 }).notNull(),
  type: mysqlEnum('type', ['RESTOCK', 'ADJUST', 'RESERVE', 'RELEASE', 'SALE', 'RETURN']).notNull(),
  quantity: int('quantity').notNull(),
  refType: varchar('ref_type', { length: 30 }),
  refId: char('ref_id', { length: 26 }),
  actorUserId: char('actor_user_id', { length: 26 }),
  note: varchar('note', { length: 255 }),
  createdAt: createdAt(),
}, (t) => [index('inv_shop_variant_idx').on(t.shopId, t.variantId, t.createdAt)]);

// ---------------------------------------------------------------- Lives
export const liveSessions = mysqlTable('live_sessions', {
  id: id(),
  shopId: shopId(),
  title: varchar('title', { length: 160 }).notNull(),
  platform: varchar('platform', { length: 16 }).notNull().default('FACEBOOK'),
  fbLiveVideoId: varchar('fb_live_video_id', { length: 60 }),
  mode: mysqlEnum('mode', ['AUTOMATIC', 'SEMI_AUTOMATIC', 'MANUAL_ASSISTED']).notNull().default('MANUAL_ASSISTED'),
  status: mysqlEnum('status', ['DRAFT', 'LIVE', 'ENDED']).notNull().default('DRAFT'),
  currentItemId: char('current_item_id', { length: 26 }),
  startedAt: datetime('started_at', { mode: 'date' }),
  endedAt: datetime('ended_at', { mode: 'date' }),
  createdAt: createdAt(),
}, (t) => [index('lives_shop_status_idx').on(t.shopId, t.status, t.createdAt)]);

export const liveSessionItems = mysqlTable('live_session_items', {
  id: id(),
  shopId: shopId(),
  liveSessionId: char('live_session_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  position: int('position').notNull(),
  fbCommentId: varchar('fb_comment_id', { length: 80 }),
  publishState: mysqlEnum('publish_state', ['NOT_PUBLISHED', 'COPIED', 'PUBLISHED_API', 'PUBLISHED_MANUAL']).notNull().default('NOT_PUBLISHED'),
  pinned: boolean('pinned').notNull().default(false),
  presentedAt: datetime('presented_at', { mode: 'date' }),
}, (t) => [index('live_items_session_idx').on(t.liveSessionId, t.position)]);

export const liveComments = mysqlTable('live_comments', {
  id: id(),
  shopId: shopId(),
  liveSessionId: char('live_session_id', { length: 26 }).notNull(),
  fbCommentId: varchar('fb_comment_id', { length: 80 }).notNull(),
  fbParentId: varchar('fb_parent_id', { length: 80 }),
  fbAuthorId: varchar('fb_author_id', { length: 40 }),
  authorName: varchar('author_name', { length: 160 }),
  message: text('message').notNull(),
  createdTime: datetime('created_time', { mode: 'date' }),
  source: varchar('source', { length: 16 }).notNull(),
  parseStatus: mysqlEnum('parse_status', ['NOT_AN_ORDER', 'ORDERED', 'NEEDS_REVIEW', 'WAITLISTED', 'REJECTED']).notNull().default('NOT_AN_ORDER'),
  parsed: json('parsed'),
  reason: varchar('reason', { length: 160 }),
  orderId: char('order_id', { length: 26 }),
  receivedAt: createdAt(),
}, (t) => [
  uniqueIndex('live_comments_uq').on(t.shopId, t.fbCommentId),
  index('live_comments_session_idx').on(t.liveSessionId, t.parseStatus),
]);

/** Compteurs atomiques par boutique (numéros de commande). */
export const shopCounters = mysqlTable('shop_counters', {
  shopId: shopId(),
  name: varchar('name', { length: 30 }).notNull(),
  value: int('value').notNull().default(0),
}, (t) => [uniqueIndex('shop_counters_pk').on(t.shopId, t.name)]);

// ---------------------------------------------------------------- Commandes
export const ORDER_STATUSES = [
  'PENDING_CONFIRMATION', 'CONFIRMED', 'PAID', 'PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURNED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ORDER_CHANNELS = ['LIVE', 'MESSENGER', 'MARKETPLACE', 'MANUAL'] as const;

export const orders = mysqlTable('orders', {
  id: id(),
  shopId: shopId(),
  number: varchar('number', { length: 24 }).notNull(),
  customerId: char('customer_id', { length: 26 }).notNull(),
  channel: mysqlEnum('channel', ORDER_CHANNELS).notNull(),
  liveSessionId: char('live_session_id', { length: 26 }),
  sourceCommentId: varchar('source_comment_id', { length: 80 }),
  status: mysqlEnum('status', ORDER_STATUSES).notNull().default('PENDING_CONFIRMATION'),
  subtotalMga: int('subtotal_mga').notNull(),
  shippingMga: int('shipping_mga').notNull().default(0),
  discountMga: int('discount_mga').notNull().default(0),
  totalMga: int('total_mga').notNull(),
  paidMga: int('paid_mga').notNull().default(0),
  deliveryAddress: varchar('delivery_address', { length: 255 }),
  deliveryCity: varchar('delivery_city', { length: 80 }),
  notes: text('notes'),
  expiresAt: datetime('expires_at', { mode: 'date' }),
  confirmedAt: datetime('confirmed_at', { mode: 'date' }),
  cancelledAt: datetime('cancelled_at', { mode: 'date' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('orders_shop_number_uq').on(t.shopId, t.number),
  index('orders_shop_status_idx').on(t.shopId, t.status, t.createdAt),
  index('orders_shop_customer_idx').on(t.shopId, t.customerId),
  index('orders_shop_live_idx').on(t.shopId, t.liveSessionId),
  uniqueIndex('orders_shop_comment_uq').on(t.shopId, t.sourceCommentId),
]);

export const orderItems = mysqlTable('order_items', {
  id: id(),
  shopId: shopId(),
  orderId: char('order_id', { length: 26 }).notNull(),
  productId: char('product_id', { length: 26 }).notNull(),
  variantId: char('variant_id', { length: 26 }).notNull(),
  nameSnapshot: varchar('name_snapshot', { length: 200 }).notNull(),
  codeSnapshot: varchar('code_snapshot', { length: 12 }).notNull(),
  variantSnapshot: varchar('variant_snapshot', { length: 60 }).notNull(),
  quantity: int('quantity').notNull(),
  unitPriceMga: int('unit_price_mga').notNull(),
}, (t) => [index('order_items_order_idx').on(t.orderId), index('order_items_shop_product_idx').on(t.shopId, t.productId)]);

export const PAYMENT_METHODS = ['MVOLA', 'ORANGE_MONEY', 'AIRTEL_MONEY', 'CASH_ON_DELIVERY', 'CASH', 'BANK'] as const;
export const payments = mysqlTable('payments', {
  id: id(),
  shopId: shopId(),
  orderId: char('order_id', { length: 26 }).notNull(),
  method: mysqlEnum('method', PAYMENT_METHODS).notNull(),
  amountMga: int('amount_mga').notNull(),
  status: mysqlEnum('status', ['PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED']).notNull().default('PENDING'),
  providerRef: varchar('provider_ref', { length: 80 }),
  confirmedByUserId: char('confirmed_by_user_id', { length: 26 }),
  confirmedAt: datetime('confirmed_at', { mode: 'date' }),
  createdAt: createdAt(),
}, (t) => [index('payments_order_idx').on(t.orderId), index('payments_shop_status_idx').on(t.shopId, t.status)]);

export const shipments = mysqlTable('shipments', {
  id: id(),
  shopId: shopId(),
  orderId: char('order_id', { length: 26 }).notNull(),
  method: mysqlEnum('method', ['COURIER', 'PICKUP', 'TAXI_BROUSSE', 'POST', 'OTHER']).notNull(),
  carrierName: varchar('carrier_name', { length: 120 }),
  trackingNote: varchar('tracking_note', { length: 255 }),
  feeMga: int('fee_mga').notNull().default(0),
  status: mysqlEnum('status', ['PENDING', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED']).notNull().default('PENDING'),
  shippedAt: datetime('shipped_at', { mode: 'date' }),
  deliveredAt: datetime('delivered_at', { mode: 'date' }),
  createdAt: createdAt(),
}, (t) => [index('shipments_order_idx').on(t.orderId)]);

// ---------------------------------------------------------------- Journal d'activité
export const auditLogs = mysqlTable('audit_logs', {
  id: bigint('id', { mode: 'number' }).autoincrement().primaryKey(),
  shopId: char('shop_id', { length: 26 }),
  actorUserId: char('actor_user_id', { length: 26 }),
  action: varchar('action', { length: 60 }).notNull(),
  entityType: varchar('entity_type', { length: 40 }).notNull(),
  entityId: char('entity_id', { length: 26 }),
  data: json('data'),
  createdAt: createdAt(),
}, (t) => [index('audit_shop_idx').on(t.shopId, t.createdAt)]);

// ---------------------------------------------------------------- Relations (pour les requêtes "with")
export const productsRelations = relations(products, ({ many }) => ({ variants: many(productVariants), images: many(productImages) }));
export const variantsRelations = relations(productVariants, ({ one }) => ({ product: one(products, { fields: [productVariants.productId], references: [products.id] }) }));
export const imagesRelations = relations(productImages, ({ one }) => ({ product: one(products, { fields: [productImages.productId], references: [products.id] }) }));
export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  items: many(orderItems),
  payments: many(payments),
  shipments: many(shipments),
}));
export const orderItemsRelations = relations(orderItems, ({ one }) => ({ order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }) }));
export const paymentsRelations = relations(payments, ({ one }) => ({ order: one(orders, { fields: [payments.orderId], references: [orders.id] }) }));
export const shipmentsRelations = relations(shipments, ({ one }) => ({ order: one(orders, { fields: [shipments.orderId], references: [orders.id] }) }));
export const customersRelations = relations(customers, ({ many }) => ({ orders: many(orders) }));
export const liveSessionsRelations = relations(liveSessions, ({ many }) => ({ items: many(liveSessionItems) }));
export const liveItemsRelations = relations(liveSessionItems, ({ one }) => ({
  session: one(liveSessions, { fields: [liveSessionItems.liveSessionId], references: [liveSessions.id] }),
  product: one(products, { fields: [liveSessionItems.productId], references: [products.id] }),
}));
