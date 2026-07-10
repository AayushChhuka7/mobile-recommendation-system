# Customer Segmentation and Intelligent Mobile Recommendation System

> A project documentation compiled from `Documentation/main.pdf` and the current
> state of the repository. Use this file as the canonical description of the
> system, the problems it solves, and the way the code is organised.

## 1. Project Identity

| Field | Value |
| --- | --- |
| Title | Customer Segmentation and Intelligent Mobile Recommendation System |
| Institution | Tribhuvan University — Institute of Engineering, National College of Engineering |
| Programme | Bachelor in Computer Engineering (BCT) |
| Type | Minor Project Proposal |
| Submitted | February 2026 |
| Authors | Aayush Chhuka (NCE080BCT002), Hom Raj Bhandari (NCE080BCT016), Sudip Kumar Tamang (NCE080BCT042), Suresh Khadka (NCE080BCT046) |
| Department | Electronics & Computer Engineering, Lalitpur, Nepal |

## 2. Problem Statement

The mobile retail industry has three recurring problems:

1. **Shallow customer understanding.** Retailers group customers only by
   demographics (age, income, city), which misses the underlying drivers of
   purchase behaviour such as tech tier and brand loyalty.
2. **Cold-start problem.** Existing recommenders need purchase or browsing
   history. New users and newly launched phones have no history, so suggestions
   are weak or impossible.
3. **Marketing guesswork.** When retailers do have customer data, there is no
   simple system that links it to marketing decisions during a new product
   launch.

The project proposes a single integrated ML pipeline that automates customer
segmentation, solves the cold-start problem, and gives marketing teams a
dashboard to match products to the right audience.

## 3. Objectives

1. Brand recommendation system that suggests suitable brands for customers
   based on purchasing trends in different locations.
2. Tech-tier classification that groups customers from high-end to budget
   buyers based on the performance level of the phones they buy.
3. Camera preference analysis that classifies customers as selfie-focused,
   photography enthusiasts, or general users.
4. Cold-start matching that pairs newly launched phones with the most suitable
   customer groups, even with no sales history.
5. Brand-loyalty / brand-switching identification from purchase sequences.
6. A user-friendly web application that exposes the above to retailers and
   customers.

## 4. Scope

### In Scope

- Three real-world datasets: phone specifications, Antutu benchmark scores, and
  large-scale e-commerce purchase history.
- XGBoost-based machine learning models for segmentation and recommendation
  tasks.
- Backend that serves recommendations to end users and identifies customer
  groups for specific products.
- Web-based dashboard (HTML/CSS/JavaScript) for both retailers and customers.

### Limitations

- No real-time stock management or automatic price optimisation.
- No native mobile app (Android/iOS) — the system is web-only.
- No direct integration with live e-commerce or payment systems.
- Only uses publicly available open datasets; no private customer data.

## 5. Literature and Theory

The proposal covers:

- **Gradient Boosting Machines** — sequential ensembling of weak learners where
  each new model corrects the residuals of the previous ones.
- **XGBoost** — extreme gradient boosting with second-order gradients, native
  missing-value handling, L1/L2 regularisation, and column subsampling.
- **Mathematical foundation:**

  $$\mathcal{L}(\theta) = \sum_{i=1}^{n} l(y_i, \hat{y}_i) + \sum_{k=1}^{K} \Omega(f_k)$$

  with the regularisation term

  $$\Omega(f) = \gamma T + \frac{1}{2} \lambda \sum_{j=1}^{T} w_j^2$$

- **Why XGBoost for this project:** mixed data types, robustness to outliers
  (price, benchmark scores), regularisation that generalises to new customers
  and phones, sequential learning that focuses on hard cases, and a strong
  track record on tabular data.

## 6. System Architecture

A modular three-tier architecture with clear separation between data, model,
and application layers.

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend   (HTML + CSS + JavaScript / planned React)        │
│  - Retailer dashboard  (location search, predictions)        │
│  - Customer portal     (preferences, recommendations)        │
│  - Auth pages          (login, register, role selection)     │
└────────────────────────┬─────────────────────────────────────┘
                         │  HTTP (JSON)
┌────────────────────────▼─────────────────────────────────────┐
│  Backend API                                                │
│  - Auth (register, login, OTP verify, forget password)       │
│  - User profile management                                  │
│  - Product / recommendation endpoints (planned)              │
│  - ML model integration layer (planned)                     │
└────────────────────────┬─────────────────────────────────────┘
                         │
        ┌────────────────┼─────────────────┐
        ▼                ▼                 ▼
   ┌─────────┐    ┌────────────┐    ┌──────────────┐
   │  Users/ │    │  XGBoost   │    │  Combined    │
   │  Otps   │    │  models    │    │  dataset     │
   │  DB     │    │  (joblib)  │    │  (specs +    │
   └─────────┘    └────────────┘    │   antutu +   │
                                    │   sales)     │
                                    └──────────────┘
```

### 6.1 User Workflows

**Retailer path.** Log in → enter a location → optionally enter phone
specifications → ML model returns top phones for that area plus camera tier,
tech tier, and brand audience insights.

**Customer path.** New user registers with camera preference, tech
expectation, and location. Returning user logs in with a customer ID. The ML
model then returns ranked personalised recommendations with match scores and
confidence indicators.

### 6.2 Data and ML Pipeline

Three sources are merged on processor and phone model:

1. Mobile phone specifications (Kaggle).
2. Antutu benchmark scores (web-scraped CSV).
3. Mobile phone sales / e-commerce transaction data (Kaggle).

The merged dataset feeds XGBoost models that:

- Predict Antutu score for new phone models.
- Classify tech tier, camera preference, and brand loyalty.
- Drive geographic brand recommendations.
- Power the product-to-audience pipeline that returns a complete audience
  profile for a new phone.

### 6.3 Database Schema (target)

Core tables described in the proposal: users (retailers + customers), customer
preference profiles (camera, tech, location), phone specifications, customer
segmentation results, recommendation history, purchase records (brand-loyalty
analysis), and aggregated location-based brand statistics.

### 6.4 Weighted Recommendation Scoring

The proposal defines a transparent scoring rule:

- Tech tier match: 50 points
- Brand affinity: 30 points
- Camera preference: 20 points

This makes the recommendation rationale easy to explain in the UI.

## 7. Testing Strategy

The proposal calls for four layers of testing:

- **Unit testing** — each model, each backend function, each DB query in
  isolation.
- **Integration testing** — Django ↔ XGBoost, frontend ↔ Django, Django ↔
  MySQL.
- **User acceptance testing** — retailers and customers exercise the real
  flows.
- **Performance testing** — prediction responses under two seconds, behaviour
  under concurrent users, cross-browser and device coverage.

## 8. Expected Outputs

### Core Features

- Responsive web application for both user types.
- Location-based category prediction for retailers.
- Personalised customer recommendations with match scores.
- Tech-tier classification (five tiers: entry → flagship).
- Camera preference classification (selfie / photography / balanced).
- Geographic brand intelligence.
- Brand loyalty identification (loyal, multi-brand, frequent switcher).
- Product-to-audience pipeline for new phones.
- Weighted recommendation scoring with explanations.
- Audience insights dashboard with segment sizes and confidence.

### Technical Deliverables

- Web application (HTML/CSS/JavaScript, with optional React).
- Backend API serving predictions and user management.
- Trained and validated XGBoost models.
- Database schema and migration scripts.
- Model integration layer with sub-500 ms predictions.
- API specs, database schema, model performance reports, and the final
  project report.

## 9. Current Repository Layout

```
mobile-recommendation-system/
├── README.md
├── Documentation/
│   ├── main.pdf              # the proposal this doc summarises
│   └── PROJECT.md            # this file
├── backend/                  # Node.js + Express + Prisma (PostgreSQL)
│   ├── package.json
│   ├── prisma.config.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   └── src/
│       ├── index.mjs         # express app entry point
│       ├── config/           # prisma client + smtp config
│       ├── controller/       # authController, userController
│       ├── middleware/       # auth, error, otp, email
│       ├── mockData/         # placeholder (now empty)
│       ├── routes/           # main, auth, user, product
│       ├── service/          # authService
│       ├── stratagies/       # passport-local strategy
│       └── validation/       # express-validator schemas
├── frontend/                 # empty placeholder (only node_modules)
├── ml/                       # empty placeholder
└── dataset/                  # empty placeholder
```

## 10. Implemented So Far

- Express server with session-backed auth (PostgreSQL session store via
  `connect-pg-simple`).
- Prisma ORM with two models: `Users` and `Otp`.
- Registration with email OTP verification via Nodemailer.
- Login, logout, password hashing (`bcrypt`), forget-password with OTP reset.
- Resend OTP that invalidates outstanding codes inside a transaction.
- Basic user CRUD (`/api/users`) guarded by an `id` validator.
- Validation via `express-validator` with a reusable `validationWith`
  middleware.
- Centralised error handling.

## 11. Not Yet Implemented (gap with the proposal)

- All XGBoost training, model artefacts, and prediction endpoints.
- The `dataset/` folder is empty.
- `ml/` has no code.
- `frontend/` is empty (only `node_modules` from a prior experiment).
- No phone / product / recommendation routes beyond a placeholder.
- No customer preference, brand-loyalty, or audience-insight tables.
- No tests (unit, integration, UAT, or performance).
- No deployment configuration.
