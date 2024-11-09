# main.py

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from typing import List
from starlette.responses import Response
from starlette.middleware.base import BaseHTTPMiddleware
import time

app = FastAPI()
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

# Custom Middleware to add Cache-Control headers
class NoCacheMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        # Only modify responses for static files
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
            response.headers["Surrogate-Control"] = "no-store"
        return response

app.add_middleware(NoCacheMiddleware)

# ConnectionManager to handle broadcaster and listeners
class ConnectionManager:
    def __init__(self):
        self.broadcaster: WebSocket = None  # Only one broadcaster
        self.listeners: List[WebSocket] = []

    async def connect_broadcaster(self, websocket: WebSocket):
        if self.broadcaster is not None and self.broadcaster.application_state != WebSocket.DISCONNECTED:
            await websocket.close(code=1000, reason="Another broadcaster is already connected.")
            print("Rejected additional broadcaster connection.")
            return False
        self.broadcaster = websocket
        print("Broadcaster connected.")
        return True

    async def disconnect_broadcaster(self):
        print("Broadcaster disconnected.")
        self.broadcaster = None

    async def connect_listener(self, websocket: WebSocket):
        self.listeners.append(websocket)
        print("Listener connected.")

    def disconnect_listener(self, websocket: WebSocket):
        if websocket in self.listeners:
            self.listeners.remove(websocket)
            print("Listener disconnected.")

    async def broadcast_to_listeners(self, data: bytes):
        disconnected = []
        for listener in self.listeners:
            try:
                await listener.send_bytes(data)
                print(f"Sent {len(data)} bytes to a listener.")
            except WebSocketDisconnect:
                disconnected.append(listener)
                print("Listener disconnected during broadcast.")
            except Exception as e:
                print(f"Error sending data to listener: {e}")
        for listener in disconnected:
            self.disconnect_listener(listener)

manager = ConnectionManager()

@app.get("/")
async def get(request: Request):
    # Append a timestamp to prevent caching
    timestamp = int(time.time())
    return templates.TemplateResponse("index.html", {"request": request, "timestamp": timestamp})

@app.websocket("/broadcast")
async def websocket_broadcaster(websocket: WebSocket):
    await websocket.accept()
    connected = await manager.connect_broadcaster(websocket)
    if not connected:
        return
    try:
        while True:
            data = await websocket.receive_bytes()
            print(f"Received {len(data)} bytes from broadcaster.")
            await manager.broadcast_to_listeners(data)
    except WebSocketDisconnect:
        print("Broadcaster disconnected.")
    except Exception as e:
        print(f"Broadcaster connection error: {e}")
    finally:
        await manager.disconnect_broadcaster()

@app.websocket("/listen")
async def websocket_listener(websocket: WebSocket):
    await websocket.accept()
    await manager.connect_listener(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            # Currently, listeners do not send messages. This can be extended for features like heartbeats.
            pass
    except WebSocketDisconnect:
        print("Listener disconnected.")
    except Exception as e:
        print(f"Listener connection error: {e}")
    finally:
        manager.disconnect_listener(websocket)
