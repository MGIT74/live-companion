-- Invariants de stock : jamais de stock négatif ni de réservation supérieure au stock.
ALTER TABLE `product_variants` ADD CONSTRAINT `variants_stock_nonneg` CHECK (`stock_on_hand` >= 0);--> statement-breakpoint
ALTER TABLE `product_variants` ADD CONSTRAINT `variants_reserved_range` CHECK (`reserved` >= 0 AND `reserved` <= `stock_on_hand`);--> statement-breakpoint
ALTER TABLE `orders` ADD CONSTRAINT `orders_amounts_nonneg` CHECK (`subtotal_mga` >= 0 AND `total_mga` >= 0 AND `paid_mga` >= 0);
