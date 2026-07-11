FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy ML code and artifacts
COPY pipeline/ ./pipeline/
COPY artifacts/ ./artifacts/
COPY After_EDA_and_Feature_ENginering.csv .

# Expose port
EXPOSE 8002

# Start FastAPI server
CMD ["uvicorn", "pipeline.serve:app", "--host", "0.0.0.0", "--port", "8002"]