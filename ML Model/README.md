# mobile-recommendation-system
Integrating ML models in mobile recommendation system

# Useful Docker command

# Stop everything
docker-compose down

# Stop and delete volumes (reset database)
docker-compose down -v

# Rebuild specific service
docker-compose up --build backend

# View logs
docker-compose logs -f backend

# Enter container
docker exec -it mobile-recommender-backend sh

# If you ever need to re-seed
docker compose run --rm db-init.