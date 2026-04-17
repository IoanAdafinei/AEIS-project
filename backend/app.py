from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import datetime

app = FastAPI()

# Allow the frontend to talk to the backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # restrict this to actual frontend IP/domain!
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "Backend is running!", "timestamp": datetime.datetime.now()}

@app.get("/process")
def fake_processing_job():
    return {
        "message": "Big Data Job Complete!",
        "data": "Processed 15GB of NDVI data in 0.001 seconds (because it's fake)."
    }