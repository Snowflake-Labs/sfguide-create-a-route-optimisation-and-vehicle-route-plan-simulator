## Native App Integration and Internal Marketplace Access

### Internal Marketplace Access (Key Points)
- Contact SIT team for access to `SFSEHOL-internal_marketplace`
- Configure `INTERNAL_MARKETPLACE` SnowCLI connection (prefer key pair auth)
- Use ACCOUNTADMIN role for marketplace operations

### Key Pair Authentication Setup (Summary)
1. Generate PKCS#8 private key and public key
2. Create service user and set `RSA_PUBLIC_KEY`
3. Configure SnowCLI with `authenticator = SNOWFLAKE_JWT`
4. Test with `snow connection test -c INTERNAL_MARKETPLACE`

### Common Commands
```bash
snow connection test -c INTERNAL_MARKETPLACE
snow sql -c INTERNAL_MARKETPLACE -q "SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_ACCOUNT()"
snow sql -c INTERNAL_MARKETPLACE -q "SHOW DATABASES"
```

### Marketplace Integration Pattern
- Create share → Grant tables → Create organization listing → Verify and publish


