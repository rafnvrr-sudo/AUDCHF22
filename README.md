# AUD/CHF Forex Predictor

Prédicteur temps réel AUD/CHF avec 10 indicateurs techniques et intégration XTB.

## Déploiement sur Render.com

### Méthode 1 : Via GitHub (recommandé)

1. Crée un repo GitHub et push ce dossier
2. Va sur https://render.com et connecte ton compte GitHub
3. Clique **New > Web Service**
4. Sélectionne ton repo
5. Render détecte automatiquement le `render.yaml`
6. Configure :
   - **Name** : audchf-predictor
   - **Runtime** : Node
   - **Build Command** : `npm install`
   - **Start Command** : `node server.js`
   - **Plan** : Free
7. Ajoute la variable d'environnement :
   - `TWELVE_DATA_KEY` = `ce1a5b235266403388d14c60dfc0961e`
8. Clique **Deploy**

### Méthode 2 : render.yaml auto-deploy

Le fichier `render.yaml` est déjà configuré. Render le détecte et configure tout automatiquement.

## Structure

```
audchf-app/
├── server.js          # Serveur Express (proxy API + static files)
├── public/
│   └── index.html     # Frontend complet (HTML/CSS/JS)
├── package.json
├── render.yaml        # Config Render.com
└── README.md
```

## Fonctionnement

- Le serveur Express sert de proxy vers l'API Twelve Data
- Le prix se rafraîchit toutes les 8 secondes via `/api/price`
- Les bougies se rechargent toutes les 60 secondes via `/api/candles`
- Le cache serveur respecte les limites du free tier (8 req/min)
- 10 indicateurs techniques : RSI, MACD, Bollinger, Stochastique, SMA, EMA, Momentum, Patterns, S/R, ATR
- Setup de trade avec boutons copier pour xStation 5

## API Twelve Data

Free tier : 8 appels/min, 800/jour.
Crée ton compte sur https://twelvedata.com si tu veux ta propre clé.
