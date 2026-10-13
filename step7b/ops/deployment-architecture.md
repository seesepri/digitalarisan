# v15 Deployment Architecture

```text
Internet
   |
TLS / managed LB or Nginx
   |
edge network
   |
Next.js app replicas ---- private network ---- PostgreSQL (managed/private preferred)
         |
         +---- migration job (short-lived, migration credentials)
         +---- payment/payout providers over HTTPS
```

The application should not be directly exposed to the Internet. PostgreSQL should not have a public listener. Financial job execution remains protected by the v9 lease/retry controls and v14 compliance approval/risk controls.
