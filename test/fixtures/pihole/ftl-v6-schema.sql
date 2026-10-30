-- The part of Pi-hole v6's long-term query database (/etc/pihole/pihole-FTL.db) that
-- dns.blocker.askers reads: FTL stores each query with ids into lookup tables, and `queries` is a
-- view that turns them back into text. Shaped after FTL's own schema (database/query-table.c) and
-- Pi-hole's documentation of the query database; tests/ubuntu/pihole-askers.sh reads the real one.
CREATE TABLE query_storage (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, type INTEGER NOT NULL, status INTEGER NOT NULL, domain INTEGER NOT NULL, client INTEGER NOT NULL, forward INTEGER, additional_info INTEGER, reply_type INTEGER, reply_time REAL, dnssec INTEGER, list_id INTEGER, ede INTEGER);
CREATE INDEX idx_queries_timestamps ON query_storage (timestamp);
CREATE TABLE domain_by_id (id INTEGER PRIMARY KEY, domain TEXT NOT NULL);
CREATE TABLE client_by_id (id INTEGER PRIMARY KEY, ip TEXT NOT NULL, name TEXT);
CREATE TABLE forward_by_id (id INTEGER PRIMARY KEY, forward TEXT NOT NULL);
CREATE TABLE addinfo_by_id (id INTEGER PRIMARY KEY, type INTEGER NOT NULL, content NOT NULL);
CREATE VIEW queries AS SELECT id, timestamp, type, status,
  CASE typeof(domain) WHEN 'integer' THEN (SELECT domain FROM domain_by_id d WHERE d.id = q.domain) ELSE domain END domain,
  CASE typeof(client) WHEN 'integer' THEN (SELECT ip FROM client_by_id c WHERE c.id = q.client) ELSE client END client,
  CASE typeof(forward) WHEN 'integer' THEN (SELECT forward FROM forward_by_id f WHERE f.id = q.forward) ELSE forward END forward,
  CASE typeof(additional_info) WHEN 'integer' THEN (SELECT content FROM addinfo_by_id a WHERE a.id = q.additional_info) ELSE additional_info END additional_info,
  reply_type, reply_time, dnssec, list_id, ede
FROM query_storage q;
