-- This is an empty migration.CREATE OR REPLACE VIEW user_analytics AS
SELECT
    u.user_id,
    u.name,
    cp.favorite_brand,
    cp.avg_budget,
    cp.recommendation_persona,
    cp.total_recommendations,
    cp.total_comparisons,
    cp.total_wishlist
FROM users u
JOIN customer_profile cp ON cp.user_id = u.user_id;

CREATE OR REPLACE VIEW admin_live_stats AS
SELECT
    (SELECT p.brand FROM recommendation_history rh
        JOIN phones p ON p.phone_id = rh.phone_id
        GROUP BY p.brand ORDER BY COUNT(*) DESC LIMIT 1)             AS most_recommended_brand,
    (SELECT AVG(max_budget) FROM user_preferences)                    AS avg_user_budget,
    (SELECT recommendation_persona FROM customer_profile
        GROUP BY recommendation_persona ORDER BY COUNT(*) DESC LIMIT 1) AS most_popular_persona,
    (SELECT AVG(overall_compatibility) FROM recommendation_history)     AS avg_compatibility;