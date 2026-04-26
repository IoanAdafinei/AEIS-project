import azure.functions as func
import requests
import json
import psycopg2
import os
import logging

# Initialize the Function App
app = func.FunctionApp(http_auth_level=func.AuthLevel.ANONYMOUS)

# Load environment variables
DB_CONN_STRING = os.environ.get("POSTGRES_CONNECTION_STRING")
CDSE_CLIENT_ID = os.environ.get("CDSE_CLIENT_ID")
CDSE_CLIENT_SECRET = os.environ.get("CDSE_CLIENT_SECRET")

COPERNICUS_STAC_URL = "https://catalogue.dataspace.copernicus.eu/stac/search"
COPERNICUS_AUTH_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"

def get_copernicus_token():
    """Fetches a fresh Bearer token using OAuth 2.0 Client Credentials."""
    data = {
        "grant_type": "client_credentials",
        "client_id": CDSE_CLIENT_ID,
        "client_secret": CDSE_CLIENT_SECRET
    }
    
    response = requests.post(COPERNICUS_AUTH_URL, data=data)
    
    if not response.ok:
        logging.error(f"Copernicus Auth Failed! Status: {response.status_code}, Body: {response.text}")
        response.raise_for_status() 
        
    return response.json().get("access_token")

@app.route(route="QueryCopernicusAPI", methods=["POST"])
def QueryCopernicusAPI(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Processing Copernicus STAC API request.')

    try:
        req_body = req.get_json()
        bbox = req_body.get('bbox')
        start_date = req_body.get('start_date')
        end_date = req_body.get('end_date')
    except ValueError:
        return func.HttpResponse("Invalid JSON payload. Please provide bbox, start_date, and end_date.", status_code=400)

    # 1. Get Authentication Token
    try:
        token = get_copernicus_token()
    except Exception as e:
        logging.error(f"Auth Error: {e}")
        debug_info = (
            f"--- AUTH CRASH REPORT ---\n"
            f"Client ID Loaded in Azure: {CDSE_CLIENT_ID is not None}\n"
            f"Client Secret Loaded in Azure: {CDSE_CLIENT_SECRET is not None}\n"
            f"Error Details: {str(e)}\n"
            f"-------------------------"
        )
        return func.HttpResponse(debug_info, status_code=401)

    # 2. Query the Copernicus STAC API
    stac_payload = {
        "collections": ["sentinel-2-l2a"],
        "bbox": bbox,
        "datetime": f"{start_date}T00:00:00Z/{end_date}T23:59:59Z",
        "query": {"eo:cloud_cover": {"lt": 20}},
        "limit": 5
    }
    
    headers = {"Authorization": f"Bearer {token}"}

    try:
        response = requests.post(COPERNICUS_STAC_URL, headers=headers, json=stac_payload)
        response.raise_for_status()
        stac_data = response.json()
    except Exception as e:
        logging.error(f"STAC API Error: {e}")
        return func.HttpResponse("STAC API Error.", status_code=502)

    features = stac_data.get('features', [])
    if not features:
        return func.HttpResponse(json.dumps({"message": "No images found."}), mimetype="application/json")

    # 3. Save to PostgreSQL
    saved_records = []
    try:
        conn = psycopg2.connect(DB_CONN_STRING)
        cursor = conn.cursor()

        for item in features:
            item_id = item['id']
            capture_date = item['properties']['datetime']
            cloud_cover = item['properties'].get('eo:cloud_cover', 0)
            footprint = json.dumps(item['geometry'])
            download_url = item['assets'].get('visual', {}).get('href', '')

            insert_query = """
                INSERT INTO stac_metadata (stac_item_id, collection_name, capture_datetime, cloud_cover, footprint, download_url)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (stac_item_id) DO NOTHING;
            """
            cursor.execute(insert_query, (item_id, 'sentinel-2-l2a', capture_date, cloud_cover, footprint, download_url))
            saved_records.append({"item_id": item_id, "cloud_cover": cloud_cover})

        conn.commit()
        cursor.close()
        conn.close()
    except Exception as e:
        logging.error(f"Database Error: {e}")
        return func.HttpResponse("Database Error.", status_code=500)

    return func.HttpResponse(
        json.dumps({"message": f"Successfully indexed {len(saved_records)} images.", "data": saved_records}),
        mimetype="application/json",
        status_code=200
    )