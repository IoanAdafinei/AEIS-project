import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'


interface CopernicusImage {
  item_id: string;
  cloud_cover?: number;
}

interface DateRange {
  start: string;
  end: string;
}

type DrawState = 'idle' | 'armed' | 'drawing';

function MapFixer() {
  const map = useMap();
  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 250);
    return () => clearTimeout(timer);
  }, [map]);
  return null;
}

type RightTab = 'map' | 'result';

function MapResizeOnTab({ activeTab }: { activeTab: RightTab }) {
  const map = useMap();
  useEffect(() => {
    if (activeTab !== 'map') return;
    const timer = setTimeout(() => {
      map.invalidateSize();
    }, 100);
    return () => clearTimeout(timer);
  }, [activeTab, map]);
  return null;
}

function CustomRectangleDraw({
  drawState,
  onBboxChange,
  onDrawEnd,
}: {
  drawState: DrawState;
  onBboxChange: (bbox: [number, number, number, number]) => void;
  onDrawEnd: () => void;
}) {
  const map = useMap();
  const startLatLng = useRef<L.LatLng | null>(null);
  const inProgressRect = useRef<L.Rectangle | null>(null);
  const drawnRect = useRef<L.Rectangle | null>(null);

  useEffect(() => {
    if (drawState === 'idle') {
      map.getContainer().style.cursor = '';
      return;
    }

    if (drawState === 'armed') {
      map.getContainer().style.cursor = 'crosshair';
      map.dragging.disable();
    }

    const onMouseDown = (e: L.LeafletMouseEvent) => {
      if (drawState !== 'armed') return;
      startLatLng.current = e.latlng;
      if (inProgressRect.current) {
        map.removeLayer(inProgressRect.current);
        inProgressRect.current = null;
      }
      inProgressRect.current = L.rectangle([e.latlng, e.latlng], {
        color: '#00f6ff',
        weight: 3,
        fillColor: '#00f6ff',
        fillOpacity: 0.15,
        dashArray: '6 4',
      }).addTo(map);
    };

    const onMouseMove = (e: L.LeafletMouseEvent) => {
      if (!startLatLng.current || !inProgressRect.current) return;
      inProgressRect.current.setBounds(L.latLngBounds(startLatLng.current, e.latlng));
    };

    const onMouseUp = () => {
      if (!startLatLng.current || !inProgressRect.current) return;

      const bounds = inProgressRect.current.getBounds();

      map.removeLayer(inProgressRect.current);
      inProgressRect.current = null;

      if (drawnRect.current) {
        map.removeLayer(drawnRect.current);
        drawnRect.current = null;
      }

      drawnRect.current = L.rectangle(bounds, {
        color: '#00f6ff',
        weight: 3,
        fillColor: '#00f6ff',
        fillOpacity: 0.15,
      }).addTo(map);

      onBboxChange([
        bounds.getWest(),
        bounds.getSouth(),
        bounds.getEast(),
        bounds.getNorth(),
      ]);

      startLatLng.current = null;
      map.getContainer().style.cursor = '';
      map.dragging.enable();
      onDrawEnd();
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      map.getContainer().style.cursor = '';
      map.dragging.enable();
    };
  }, [drawState, map, onBboxChange, onDrawEnd]);

  return null;
}

function App() {
  const [bbox, setBbox] = useState<[number, number, number, number]>([22.0, 43.0, 28.0, 48.0])
  const [dates, setDates] = useState<DateRange>({ start: '2026-04-01', end: '2026-04-10' })
  const [images, setImages] = useState<CopernicusImage[]>([])
  const [loading, setLoading] = useState<boolean>(false)
  const [processingStatus, setProcessingStatus] = useState<string>("")
  const [selectedImageId, setSelectedImageId] = useState<string | null>(null)
  const [drawState, setDrawState] = useState<DrawState>('idle')
  const [resultImageUrl, setResultImageUrl] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<RightTab>('map')

  useEffect(() => {
    if (resultImageUrl) setActiveTab('result');
  }, [resultImageUrl]);

  const handleBboxChange = useCallback((newBbox: [number, number, number, number]) => {
    setBbox(newBbox);
  }, []);

  const handleDrawEnd = useCallback(() => {
    setDrawState('idle');
  }, []);

  const handleDrawButtonClick = () => {
    setDrawState((s) => (s === 'idle' ? 'armed' : 'idle'));
  };

  const clientId = useRef<string>(Math.random().toString(36).substring(7)).current;
  const ws = useRef<WebSocket | null>(null);

  useEffect(() => {
    const wsBaseUrl = import.meta.env.VITE_WS_API as string || 'ws://localhost:8000/ws';
    const wsUrl = `${wsBaseUrl}/${clientId}`;
    ws.current = new WebSocket(wsUrl);

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.status === 'completed') {
        setResultImageUrl(data.image_url);
        setProcessingStatus('Processing complete!');
        setLoading(false);
      }
      else if (data.status === 'failed') {
        setProcessingStatus(`Processing failed: ${data.error}`);
        setLoading(false);
      }
    };

    return () => {
      ws.current?.close();
    };
  }, [clientId]);

  const searchImages = async (): Promise<void> => {
    setLoading(true);
    setProcessingStatus("Querying Copernicus API...");
    setImages([]);

    try {
      const apiUrl = import.meta.env.VITE_INGESTION_API as string || 'http://localhost:7071/api/QueryCopernicusAPI';
      const response = await axios.post(apiUrl, {
        bbox: bbox,
        start_date: dates.start,
        end_date: dates.end
      });

      setImages(response.data.data || []);
      setProcessingStatus(`Found ${response.data.data?.length || 0} matching images.`);
    } catch (error) {
      console.error("Search failed:", error);
      setProcessingStatus("Failed to search. Check logs.");
    } finally {
      setLoading(false);
    }
  };

  const processImage = async (stacItemId: string): Promise<void> => {
    setLoading(true);
    setProcessingStatus(`Initiating processing for ${stacItemId}...`);
    setResultImageUrl(null);

    try {
      const apiUrl = import.meta.env.VITE_PROCESSOR_API as string || 'http://localhost:8000/process';
      await axios.post(apiUrl, {
        stac_item_id: stacItemId,
        bbox: bbox,
        client_id: clientId,
        start_date: dates.start,
        end_date: dates.end
      });
      setProcessingStatus("Job queued! Waiting for Sentinel Hub background task...");
    } catch (error) {
      console.error("Processing failed:", error);
      setProcessingStatus("Processing request failed to send.");
      setLoading(false);
    }
  };

  const drawButtonConfig = {
    idle: {
      label: '⛶ Define Target Area',
      className: 'bg-slate-800/80 hover:bg-slate-700 text-gray-100 border border-slate-500 backdrop-blur-sm',
    },
    armed: {
      label: '⏹ Cancel Targeting',
      className: 'bg-rose-500/20 hover:bg-rose-500/40 text-rose-200 border border-rose-500/50 backdrop-blur-sm animate-pulse',
    },
    drawing: {
      label: '⏹ Release to Lock',
      className: 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/50 backdrop-blur-sm',
    },
  }[drawState];

  return (
    <div className="absolute inset-0 flex p-8 gap-8 bg-gradient-to-br from-gray-950 via-[#0a0f18] to-black font-mono text-gray-100 overflow-hidden">

      {/* --- LEFT SIDEBAR --- */ }
      <div className="flex flex-col w-[420px] shrink-0 p-8 bg-gray-900/60 backdrop-blur-xl border border-white/10 rounded-2xl overflow-x-hidden overflow-y-auto custom-scrollbar z-10 shadow-2xl relative">

        <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50"></div>

        <div className="mb-10">
          <h1 className="text-3xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-blue-500 tracking-wider mb-2 drop-shadow-sm leading-tight">
            Geospatial Intelligence Pipeline
          </h1>
          <p className="text-xs text-cyan-400/80 uppercase tracking-[0.2em] font-semibold">Satellite Orchestrator Platform</p>
        </div>

        {/* DATE RANGE */ }
        <section className="mb-8 relative">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500/70"></span>
            Temporal Bounds
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="relative group">
              <input
                type="date"
                value={ dates.start }
                onChange={ (e) => setDates((d) => ({ ...d, start: e.target.value })) }
                className="w-full bg-black/60 border border-white/20 rounded-lg px-4 py-3 text-base text-white focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/80 transition-all [color-scheme:dark]"
              />
            </div>
            <div className="relative group">
              <input
                type="date"
                value={ dates.end }
                onChange={ (e) => setDates((d) => ({ ...d, end: e.target.value })) }
                className="w-full bg-black/60 border border-white/20 rounded-lg px-4 py-3 text-base text-white focus:outline-none focus:border-cyan-500/80 focus:ring-1 focus:ring-cyan-500/80 transition-all [color-scheme:dark]"
              />
            </div>
          </div>
        </section>

        {/* BBOX + MAP */ }
        <section className="mb-8">
          <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500/70"></span>
            Spatial Bounds
          </div>

          <div className="grid grid-cols-4 gap-3 mb-5">
            { [{ label: 'W', value: bbox[0] }, { label: 'S', value: bbox[1] }, { label: 'E', value: bbox[2] }, { label: 'N', value: bbox[3] }].map(({ label, value }) => (
              <div key={ label } className="bg-black/40 border border-white/10 rounded-lg py-3 flex flex-col items-center justify-center">
                <span className="text-xs text-gray-400 mb-1">{ label }</span>
                <span className="text-sm text-cyan-200 font-mono font-semibold">{ value.toFixed(5) }</span>
              </div>
            )) }
          </div>

          <button
            onClick={ handleDrawButtonClick }
            className={ `w-full text-sm font-bold py-4 rounded-lg mb-4 transition-all duration-300 shadow-lg ${drawButtonConfig.className}` }
          >
            { drawButtonConfig.label }
          </button>

          {/* Map hint (the actual map lives in the right panel now) */ }
          <div
            onClick={ () => setActiveTab('map') }
            className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 px-4 py-3 text-xs text-cyan-300/80 leading-relaxed cursor-pointer hover:bg-cyan-500/10 transition-colors"
          >
            💡 Use the large map on the right to draw your bounding box.
          </div>
        </section>

        {/* SEARCH BUTTON */ }
        <button
          onClick={ searchImages }
          disabled={ loading }
          className="w-full relative group overflow-hidden bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-400 text-white font-bold py-4 px-4 rounded-xl transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)] mb-8 shrink-0 text-base tracking-widest uppercase"
        >
          <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]"></div>
          <span className="relative">
            { loading && images.length === 0 ? 'Scanning Copernicus...' : 'Initialize Search' }
          </span>
        </button>

        {/* RESULTS */ }
        { images.length > 0 && (
          <section className="mb-6">
            <div className="text-xs font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2"><span className="w-2 h-2 rounded-full bg-emerald-500/70"></span> Discovered Assets</span>
              <span className="bg-white/10 px-3 py-1 rounded text-gray-100">{ images.length }</span>
            </div>

            <ul className="flex flex-col gap-3">
              { images.map((img) => (
                <li
                  key={ img.item_id }
                  onClick={ () => setSelectedImageId(img.item_id) }
                  className={ `p-4 rounded-lg border-2 cursor-pointer transition-all relative overflow-hidden flex flex-col justify-between ${selectedImageId === img.item_id
                      ? 'border-cyan-400 bg-cyan-900/60 shadow-[0_0_15px_rgba(34,211,238,0.3)]'
                      : 'border-white/10 bg-black/40 hover:border-white/30 hover:bg-white/5'
                    }` }
                >
                  <div className="flex justify-between items-start mb-2">
                    <div className={ `text-sm font-semibold truncate ${selectedImageId === img.item_id ? 'text-white' : 'text-gray-200'}` }>
                      { img.item_id }
                    </div>
                    { selectedImageId === img.item_id && (
                      <span className="text-[10px] font-bold bg-cyan-500 text-white px-2 py-1 rounded uppercase tracking-wider shrink-0 ml-3 shadow-md">
                        Selected
                      </span>
                    ) }
                  </div>

                  { img.cloud_cover !== undefined && (
                    <div className={ `text-sm flex items-center gap-2 ${selectedImageId === img.item_id ? 'text-cyan-200' : 'text-gray-400'}` }>
                      <span className="opacity-80">☁️</span> { img.cloud_cover.toFixed(1) }% Cloud Obscurity
                    </div>
                  ) }
                </li>
              )) }
            </ul>
          </section>
        ) }

        {/* PROCESS BUTTON */ }
        { images.length > 0 && (
          <button
            onClick={ () => selectedImageId && processImage(selectedImageId) }
            disabled={ !selectedImageId || loading }
            className="w-full mt-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-400 text-white font-bold py-4 px-4 rounded-xl transition-all shadow-[0_0_15px_rgba(16,185,129,0.2)] shrink-0 text-base tracking-widest uppercase"
          >
            <span className="relative">
              { loading && resultImageUrl === null && images.length > 0 ? 'Executing Pipeline...' : 'Process NDVI' }
            </span>
          </button>
        ) }

        {/* STATUS LOG */ }
        { processingStatus && (
          <div className="mt-8 p-4 bg-black/60 border border-white/10 rounded-lg text-sm text-cyan-300 leading-relaxed font-mono shadow-inner border-l-4 border-l-cyan-500 shrink-0">
            &gt; { processingStatus }
            { loading && <span className="animate-pulse ml-1">_</span> }
          </div>
        ) }

      </div>

      {/* --- RIGHT PANEL: MAP + RESULTS --- */ }
      <div className="flex-1 flex flex-col relative bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')] bg-black/40 border border-white/10 rounded-2xl overflow-hidden p-6 shadow-2xl">

        <div className="absolute inset-0 pointer-events-none opacity-5 bg-[linear-gradient(rgba(255,255,255,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.1)_1px,transparent_1px)] bg-[size:40px_40px]"></div>

        {/* Tab bar */ }
        <div className="flex gap-2 mb-4 shrink-0 z-10 relative">
          <button
            onClick={ () => setActiveTab('map') }
            className={ `px-5 py-2.5 rounded-lg text-xs font-bold tracking-[0.2em] uppercase transition-all border ${activeTab === 'map'
                ? 'bg-cyan-500/20 border-cyan-400 text-cyan-100 shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                : 'bg-black/40 border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/30'
              }` }
          >
            🗺️ Target Map
          </button>
          <button
            onClick={ () => setActiveTab('result') }
            disabled={ !resultImageUrl }
            className={ `px-5 py-2.5 rounded-lg text-xs font-bold tracking-[0.2em] uppercase transition-all border disabled:opacity-40 disabled:cursor-not-allowed ${activeTab === 'result'
                ? 'bg-emerald-500/20 border-emerald-400 text-emerald-100 shadow-[0_0_15px_rgba(16,185,129,0.3)]'
                : 'bg-black/40 border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/30'
              }` }
          >
            🛰️ NDVI Output
          </button>
        </div>

        {/* MAP PANEL (always mounted, hidden when not active) */ }
        <div className={ `flex-1 min-h-0 rounded-2xl border border-white/10 overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.5)] z-10 relative ${activeTab === 'map' ? 'flex flex-col' : 'hidden'}` }>
          <MapContainer center={ [45.85, 24.89] } zoom={ 5 } style={ { height: '100%', width: '100%', backgroundColor: '#fff' } } zoomControl={ true }>
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapFixer />
            <MapResizeOnTab activeTab={ activeTab } />
            <CustomRectangleDraw drawState={ drawState } onBboxChange={ handleBboxChange } onDrawEnd={ handleDrawEnd } />
          </MapContainer>
        </div>

        {/* RESULT PANEL */ }
        <div className={ `flex-1 min-h-0 rounded-2xl border border-white/10 bg-black/40 backdrop-blur-xl overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.5)] z-10 relative ${activeTab === 'result' ? 'flex flex-col' : 'hidden'}` }>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-3/4 h-3/4 bg-cyan-500/10 blur-[100px] pointer-events-none"></div>

          { resultImageUrl ? (
            <>
              <div className="bg-white/5 px-8 py-4 border-b border-white/5 flex justify-between items-center backdrop-blur-md shrink-0">
                <h2 className="text-white text-sm tracking-[0.2em] uppercase font-bold flex items-center gap-3">
                  <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_#10b981]"></span>
                  NDVI Output Generated
                </h2>

                <a
                  href={ resultImageUrl }
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 bg-cyan-500/20 hover:bg-cyan-500/40 text-cyan-100 text-sm font-bold tracking-widest border border-cyan-400 hover:border-cyan-300 px-5 py-2.5 rounded-lg transition-all shadow-[0_0_10px_rgba(6,182,212,0.2)] hover:shadow-[0_0_20px_rgba(6,182,212,0.5)]"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={ 2 } d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  EXPORT RAW
                </a>
              </div>
              <div className="flex-1 min-h-0 flex items-center justify-center p-4 relative z-10">
                <img
                  src={ resultImageUrl }
                  alt="Processed NDVI"
                  className="max-w-full max-h-full w-auto h-auto object-contain rounded-xl shadow-2xl border border-white/10"
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-gray-400">
              <div className="relative mb-8">
                <div className="absolute inset-0 bg-cyan-500/20 blur-2xl rounded-full animate-pulse"></div>
                <div className="text-7xl opacity-50 relative z-10 drop-shadow-lg">🛰️</div>
              </div>
              <p className="text-sm tracking-[0.4em] uppercase text-gray-500 font-bold">Awaiting Telemetry</p>
            </div>
          ) }
        </div>
      </div>
    </div>
  )
}

export default App
