ALTER TABLE content_items
  DROP CONSTRAINT IF EXISTS content_items_content_type_check;

ALTER TABLE content_items
  ADD CONSTRAINT content_items_content_type_check
  CHECK (content_type IN ('package', 'blog', 'visa', 'service', 'destination', 'listing', 'hotel'));

UPDATE content_items
SET active = false, updated_at = now()
WHERE id IN (
  'pkg-1', 'pkg-2', 'pkg-3',
  'blog-1', 'blog-2', 'blog-3',
  'visa-uae', 'visa-uk', 'visa-usa', 'visa-canada', 'visa-australia', 'visa-schengen', 'visa-singapore', 'visa-thailand'
);

INSERT INTO content_items (id, content_type, data) VALUES
('service-flights', 'service', '{"id":"flights","title":"Flights","subtitle":"Book domestic & international flights","icon":"airplane-outline"}'),
('service-hotels', 'service', '{"id":"hotels","title":"Hotels","subtitle":"Handpicked stays across the globe","icon":"bed-outline"}'),
('service-buses', 'service', '{"id":"buses","title":"Buses","subtitle":"Comfortable bus travel","icon":"bus-outline"}'),
('service-trains', 'service', '{"id":"trains","title":"Trains","subtitle":"Rail bookings made easy","icon":"train-outline"}'),
('service-packages', 'service', '{"id":"packages","title":"Tours & Packages","subtitle":"Curated holiday experiences","icon":"map-outline"}'),
('service-visa', 'service', '{"id":"visa","title":"Visa Services","subtitle":"Expert visa assistance","icon":"document-text-outline"}')
ON CONFLICT (id) DO NOTHING;