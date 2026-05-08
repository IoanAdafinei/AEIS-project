from fastapi import FastAPI, WebSocket, WebSocketDisconnect, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import requests
from datetime import datetime, timedelta, timezone
from azure.storage.blob import generate_blob_sas, BlobSasPermissions, BlobServiceClient
import os
import logging
from typing import Dict

class ConnectionManager:
    def __init__(self):
        # Stores active connections by a unique client_id
        self.active_connections: Dict[str, WebSocket] = {}

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]

    async def send_message(self, message: dict, client_id: str):
        if client_id in self.active_connections:
            await self.active_connections[client_id].send_json(message)

manager = ConnectionManager()


app = FastAPI(title="Sentinel Hub Processing API")
# Allow the frontend to talk to the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Typically we would restrict this to actual frontend IP/domain, but for now we keep it to allow all
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
logging.basicConfig(level=logging.INFO)

# Environment Variables
CDSE_CLIENT_ID = os.environ.get("CDSE_CLIENT_ID")
CDSE_CLIENT_SECRET = os.environ.get("CDSE_CLIENT_SECRET")
AZURE_STORAGE_CONNECTION_STRING = os.environ.get("AZURE_STORAGE_CONNECTION_STRING")

CONTAINER_NAME = "processed-images"

class ProcessRequest(BaseModel):
    stac_item_id: str
    bbox: list
    client_id: str

def calculate_image_dimensions(bbox: list, max_pixels=2048):
    min_lon, min_lat, max_lon, max_lat = bbox
    
    # Calculate the physical aspect ratio of the bounding box
    width_deg = max_lon - min_lon
    height_deg = max_lat - min_lat
    aspect_ratio = width_deg / height_deg

    if aspect_ratio > 1:
        # Wider than it is tall
        width = max_pixels
        height = int(max_pixels / aspect_ratio)
    else:
        # Taller than it is wide
        height = max_pixels
        width = int(max_pixels * aspect_ratio)

    return width, height


def get_copernicus_token():
    url = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
    data = {"grant_type": "client_credentials", "client_id": CDSE_CLIENT_ID, "client_secret": CDSE_CLIENT_SECRET}
    response = requests.post(url, data=data)
    response.raise_for_status()
    return response.json().get("access_token")


def get_secure_image_url(blob_name: str) -> str:
    account_key = dict(item.split("=", 1) for item in AZURE_STORAGE_CONNECTION_STRING.split(";"))["AccountKey"]
    account_name = dict(item.split("=", 1) for item in AZURE_STORAGE_CONNECTION_STRING.split(";"))["AccountName"]

    sas_token = generate_blob_sas(
        account_name=account_name,
        container_name=CONTAINER_NAME,
        blob_name=blob_name,
        account_key=account_key,
        permission=BlobSasPermissions(read=True),
        expiry=datetime.now(timezone.utc) + timedelta(minutes=15) 
    )
    
    return f"https://{account_name}.blob.core.windows.net/{CONTAINER_NAME}/{blob_name}?{sas_token}"


async def process_ndvi_via_sentinel_hub(stac_item_id: str, bbox: list, client_id: str):
    logging.info(f"Starting Sentinel Hub job for {stac_item_id}")
    try:
        token = get_copernicus_token()
        headers = {"Authorization": f"Bearer {token}", "Accept": "image/png"}

        # 1. Get the Date from the STAC API
        stac_url = f"https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-l2a/items/{stac_item_id}"
        stac_data = requests.get(stac_url).json()
        date_str = stac_data['properties']['datetime'][:10]
        
        # 2. Calculate image size based on the user's drawn box
        width, height = calculate_image_dimensions(bbox, max_pixels=2048)

        # 3. The Evalscript: This JavaScript runs on Copernicus servers
        evalscript = """
        //VERSION=3
        function setup() {
            return {
                input: ["B04", "B08", "dataMask"],
                output: { bands: 4 }
            };
        }
        function evaluatePixel(sample) {
            if (sample.dataMask === 0) return [0, 0, 0, 0]; // Transparent outside image
            let ndvi = (sample.B08 - sample.B04) / (sample.B08 + sample.B04);

            // Color map: Water (Blue), Soil (Brown), Vegetation (Green shades)
            if (ndvi < 0) return [0.1, 0.3, 0.8, 1]; // Water
            if (ndvi < 0.2) return [0.6, 0.4, 0.2, 1]; // Bare Soil
            if (ndvi < 0.5) return [0.4, 0.8, 0.2, 1]; // Light Veg
            return [0.1, 0.5, 0.1, 1]; // Dense Veg
        }
        """

        # 4. Build the Sentinel Hub Process API Payload
        process_payload = {
            "input": {
                "bounds": {
                    "bbox": bbox,
                    "properties": {"crs": "http://www.opengis.net/def/crs/EPSG/0/4326"}
                },
                "data": [
                    {
                        "type": "sentinel-2-l2a",
                        "dataFilter": {
                            "timeRange": {
                                "from": f"{date_str}T00:00:00Z",
                                "to": f"{date_str}T23:59:59Z"
                            },
                            "maxCloudCoverage": 20
                        }
                    }
                ]
            },
            "output": {
                "width": width,
                "height": height,
                "responses": [
                    {
                        "identifier": "default",
                        "format": {
                            "type": "image/png"
                        }
                    }
                ]
            },
            "evalscript": evalscript
        }

        # 5. Trigger the Process API
        logging.info("Asking Sentinel Hub to calculate NDVI...")
        process_url = "https://sh.dataspace.copernicus.eu/api/v1/process"
        response = requests.post(process_url, headers=headers, json=process_payload)
        
        if not response.ok:
            raise Exception(f"Sentinel Hub Error: {response.text}")

        # 6. Upload the resulting PNG to Azure Blob Storage
        logging.info("Calculation complete. Uploading PNG to Azure...")
        blob_service_client = BlobServiceClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING)
        container_client = blob_service_client.get_container_client(CONTAINER_NAME)
        
        if not container_client.exists():
            container_client.create_container()

        blob_name = f"{stac_item_id}_NDVI.png"
        blob_client = blob_service_client.get_blob_client(container=CONTAINER_NAME, blob=blob_name)
        
        # Upload the raw bytes from the API response
        blob_client.upload_blob(response.content, overwrite=True, blob_type="BlockBlob")

        image_url = get_secure_image_url(blob_name)

        await manager.send_message({
            "status": "completed",
            "image_url": image_url
        }, client_id)
        
    except Exception as e:
        logging.error(f"Processing failed: {e}")
        await manager.send_message({
            "status": "failed",
            "error": str(e)
        }, client_id)


@app.post("/process")
async def start_processing_job(request: ProcessRequest, background_tasks: BackgroundTasks):
    background_tasks.add_task(
        process_ndvi_via_sentinel_hub, 
        request.stac_item_id, 
        request.bbox, 
        request.client_id
    )

    return {"message": "Sentinel Hub Job accepted.", "stac_item_id": request.stac_item_id}


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(client_id)
