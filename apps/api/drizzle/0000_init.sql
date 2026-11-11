CREATE TABLE `audit_logs` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`shop_id` char(26),
	`actor_user_id` char(26),
	`action` varchar(60) NOT NULL,
	`entity_type` varchar(40) NOT NULL,
	`entity_id` char(26),
	`data` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`full_name` varchar(120),
	`phone` varchar(20),
	`email` varchar(191),
	`address` varchar(255),
	`city` varchar(80),
	`fb_user_id` varchar(40),
	`messenger_psid` varchar(40),
	`notes` text,
	`tags` json,
	`is_blocked` boolean NOT NULL DEFAULT false,
	`cancel_count` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `customers_shop_phone_uq` UNIQUE(`shop_id`,`phone`)
);
--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`variant_id` char(26) NOT NULL,
	`type` enum('RESTOCK','ADJUST','RESERVE','RELEASE','SALE','RETURN') NOT NULL,
	`quantity` int NOT NULL,
	`ref_type` varchar(30),
	`ref_id` char(26),
	`actor_user_id` char(26),
	`note` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inventory_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `live_comments` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`live_session_id` char(26) NOT NULL,
	`fb_comment_id` varchar(80) NOT NULL,
	`fb_parent_id` varchar(80),
	`fb_author_id` varchar(40),
	`author_name` varchar(160),
	`message` text NOT NULL,
	`created_time` datetime,
	`source` varchar(16) NOT NULL,
	`parse_status` enum('NOT_AN_ORDER','ORDERED','NEEDS_REVIEW','WAITLISTED','REJECTED') NOT NULL DEFAULT 'NOT_AN_ORDER',
	`parsed` json,
	`reason` varchar(160),
	`order_id` char(26),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `live_comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `live_comments_uq` UNIQUE(`shop_id`,`fb_comment_id`)
);
--> statement-breakpoint
CREATE TABLE `live_session_items` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`live_session_id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`position` int NOT NULL,
	`fb_comment_id` varchar(80),
	`publish_state` enum('NOT_PUBLISHED','COPIED','PUBLISHED_API','PUBLISHED_MANUAL') NOT NULL DEFAULT 'NOT_PUBLISHED',
	`pinned` boolean NOT NULL DEFAULT false,
	`presented_at` datetime,
	CONSTRAINT `live_session_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `live_sessions` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`title` varchar(160) NOT NULL,
	`platform` varchar(16) NOT NULL DEFAULT 'FACEBOOK',
	`fb_live_video_id` varchar(60),
	`mode` enum('AUTOMATIC','SEMI_AUTOMATIC','MANUAL_ASSISTED') NOT NULL DEFAULT 'MANUAL_ASSISTED',
	`status` enum('DRAFT','LIVE','ENDED') NOT NULL DEFAULT 'DRAFT',
	`current_item_id` char(26),
	`started_at` datetime,
	`ended_at` datetime,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `live_sessions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`order_id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`variant_id` char(26) NOT NULL,
	`name_snapshot` varchar(200) NOT NULL,
	`code_snapshot` varchar(12) NOT NULL,
	`variant_snapshot` varchar(60) NOT NULL,
	`quantity` int NOT NULL,
	`unit_price_mga` int NOT NULL,
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`number` varchar(24) NOT NULL,
	`customer_id` char(26) NOT NULL,
	`channel` enum('LIVE','MESSENGER','MARKETPLACE','MANUAL') NOT NULL,
	`live_session_id` char(26),
	`source_comment_id` varchar(80),
	`status` enum('PENDING_CONFIRMATION','CONFIRMED','PAID','PREPARING','SHIPPED','DELIVERED','CANCELLED','RETURNED') NOT NULL DEFAULT 'PENDING_CONFIRMATION',
	`subtotal_mga` int NOT NULL,
	`shipping_mga` int NOT NULL DEFAULT 0,
	`discount_mga` int NOT NULL DEFAULT 0,
	`total_mga` int NOT NULL,
	`paid_mga` int NOT NULL DEFAULT 0,
	`delivery_address` varchar(255),
	`delivery_city` varchar(80),
	`notes` text,
	`expires_at` datetime,
	`confirmed_at` datetime,
	`cancelled_at` datetime,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `orders_shop_number_uq` UNIQUE(`shop_id`,`number`),
	CONSTRAINT `orders_shop_comment_uq` UNIQUE(`shop_id`,`source_comment_id`)
);
--> statement-breakpoint
CREATE TABLE `payments` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`order_id` char(26) NOT NULL,
	`method` enum('MVOLA','ORANGE_MONEY','AIRTEL_MONEY','CASH_ON_DELIVERY','CASH','BANK') NOT NULL,
	`amount_mga` int NOT NULL,
	`status` enum('PENDING','CONFIRMED','FAILED','REFUNDED') NOT NULL DEFAULT 'PENDING',
	`provider_ref` varchar(80),
	`confirmed_by_user_id` char(26),
	`confirmed_at` datetime,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_images` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`url` varchar(500) NOT NULL,
	`position` int NOT NULL DEFAULT 0,
	CONSTRAINT `product_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`product_id` char(26) NOT NULL,
	`label` varchar(60) NOT NULL,
	`price_mga` int,
	`stock_on_hand` int NOT NULL DEFAULT 0,
	`reserved` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_variants_id` PRIMARY KEY(`id`),
	CONSTRAINT `variants_product_label_uq` UNIQUE(`product_id`,`label`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`code` varchar(12) NOT NULL,
	`name` varchar(160) NOT NULL,
	`description` text,
	`price_mga` int NOT NULL,
	`is_published` boolean NOT NULL DEFAULT true,
	`archived_at` datetime,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_shop_code_uq` UNIQUE(`shop_id`,`code`)
);
--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`order_id` char(26) NOT NULL,
	`method` enum('COURIER','PICKUP','TAXI_BROUSSE','POST','OTHER') NOT NULL,
	`carrier_name` varchar(120),
	`tracking_note` varchar(255),
	`fee_mga` int NOT NULL DEFAULT 0,
	`status` enum('PENDING','IN_TRANSIT','DELIVERED','FAILED','RETURNED') NOT NULL DEFAULT 'PENDING',
	`shipped_at` datetime,
	`delivered_at` datetime,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shipments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shop_counters` (
	`shop_id` char(26) NOT NULL,
	`name` varchar(30) NOT NULL,
	`value` int NOT NULL DEFAULT 0,
	CONSTRAINT `shop_counters_pk` UNIQUE(`shop_id`,`name`)
);
--> statement-breakpoint
CREATE TABLE `shop_members` (
	`id` char(26) NOT NULL,
	`shop_id` char(26) NOT NULL,
	`user_id` char(26) NOT NULL,
	`role` enum('OWNER','MANAGER','LIVE_ASSISTANT','SALES') NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shop_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `shop_members_uq` UNIQUE(`shop_id`,`user_id`)
);
--> statement-breakpoint
CREATE TABLE `shops` (
	`id` char(26) NOT NULL,
	`slug` varchar(80) NOT NULL,
	`name` varchar(120) NOT NULL,
	`city` varchar(80),
	`phone` varchar(20),
	`status` enum('ACTIVE','SUSPENDED','CLOSED') NOT NULL DEFAULT 'ACTIVE',
	`reservation_ttl_minutes` int NOT NULL DEFAULT 1440,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shops_id` PRIMARY KEY(`id`),
	CONSTRAINT `shops_slug_uq` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(26) NOT NULL,
	`email` varchar(191) NOT NULL,
	`phone` varchar(20),
	`password_hash` varchar(100) NOT NULL,
	`full_name` varchar(120) NOT NULL,
	`locale` varchar(5) NOT NULL DEFAULT 'fr',
	`is_platform_admin` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_uq` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE INDEX `audit_shop_idx` ON `audit_logs` (`shop_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `customers_shop_fb_idx` ON `customers` (`shop_id`,`fb_user_id`);--> statement-breakpoint
CREATE INDEX `customers_shop_psid_idx` ON `customers` (`shop_id`,`messenger_psid`);--> statement-breakpoint
CREATE INDEX `customers_shop_name_idx` ON `customers` (`shop_id`,`full_name`);--> statement-breakpoint
CREATE INDEX `inv_shop_variant_idx` ON `inventory_movements` (`shop_id`,`variant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `live_comments_session_idx` ON `live_comments` (`live_session_id`,`parse_status`);--> statement-breakpoint
CREATE INDEX `live_items_session_idx` ON `live_session_items` (`live_session_id`,`position`);--> statement-breakpoint
CREATE INDEX `lives_shop_status_idx` ON `live_sessions` (`shop_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_shop_product_idx` ON `order_items` (`shop_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `orders_shop_status_idx` ON `orders` (`shop_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `orders_shop_customer_idx` ON `orders` (`shop_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `orders_shop_live_idx` ON `orders` (`shop_id`,`live_session_id`);--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `payments_shop_status_idx` ON `payments` (`shop_id`,`status`);--> statement-breakpoint
CREATE INDEX `variants_shop_idx` ON `product_variants` (`shop_id`);--> statement-breakpoint
CREATE INDEX `shipments_order_idx` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `shop_members_user_idx` ON `shop_members` (`user_id`);