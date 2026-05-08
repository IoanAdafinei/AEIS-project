CREATE TABLE IF NOT EXISTS stac_metadata (
    id SERIAL PRIMARY KEY,
    stac_item_id VARCHAR(255) UNIQUE NOT NULL,
    collection_name VARCHAR(100) NOT NULL,
    capture_datetime TIMESTAMP NOT NULL,
    cloud_cover DECIMAL(5,2),
    footprint JSONB,
    download_url TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stac_search ON stac_metadata(capture_datetime, cloud_cover);