-- Demo data so the stack is useful the moment it boots.
-- Coordinates are around Austin, TX and line up with mock/server.js's fake
-- geocoder, so distances and routes look sensible in a demo.
--
-- Safe to delete for a real client: replace with their actual crew.

INSERT INTO partners (full_name, email, phone, base_lat, base_lng, service_radius_km, skills, max_jobs_per_day)
VALUES
  -- Downtown all-rounder. Closest to most jobs, holds the common skills.
  ('Dave Okafor',   'dave@example-plumbing.com',   '+15125550111', 30.2672, -97.7431, 35,
   ARRAY['general_plumbing','drain','water_heater','emergency'], 6),

  -- Gas specialist. Narrow skill set, so wins tankless/gas work on
  -- specialisation even when someone else is marginally closer.
  ('Maria Delgado', 'maria@example-plumbing.com',  '+15125550112', 30.3505, -97.7500, 45,
   ARRAY['general_plumbing','gas_line','water_heater','backflow_certified'], 5),

  -- Heavy equipment. Big radius because sewer/excavation jobs are rarer.
  ('Sam Whitfield', 'sam@example-plumbing.com',    '+15125550113', 30.1900, -97.8200, 60,
   ARRAY['general_plumbing','sewer','excavation','repipe'], 4),

  -- Apprentice-level: general work only, low cap.
  ('Tia Nguyen',    'tia@example-plumbing.com',    '+15125550114', 30.2900, -97.6900, 30,
   ARRAY['general_plumbing','drain'], 7),

  -- Inactive on purpose: proves the hard filter works in a live demo.
  ('Rob Castellan', 'rob@example-plumbing.com',    '+15125550115', 30.2700, -97.7400, 40,
   ARRAY['general_plumbing','water_heater','gas_line','sewer'], 6)
ON CONFLICT DO NOTHING;

UPDATE partners SET active = FALSE WHERE email = 'rob@example-plumbing.com';
