"""OpenMaven API — FastAPI application entry point."""

from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from routes.graph import router as graph_router
from routes.health import router as health_router
from routes.ingest import router as ingest_router
from routes.objects import router as objects_router
from routes.ontology import router as ontology_router
from routes.query import router as query_router
from routes.search import router as search_router
from routes.sim_query import router as sim_query_router
from routes.simulation import router as simulation_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    from dependencies import sim_manager
    sim_manager.start()
    yield
    sim_manager.stop()
    from dependencies import store
    if hasattr(store, "close"):
        store.close()


app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health_router)
app.include_router(ontology_router, prefix="/api/ontology")
app.include_router(objects_router, prefix="/api")
app.include_router(graph_router, prefix="/api")
app.include_router(search_router, prefix="/api")
app.include_router(query_router, prefix="/api")
app.include_router(ingest_router, prefix="/api")
app.include_router(sim_query_router, prefix="/api")
app.include_router(simulation_router, prefix="/api")


if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
