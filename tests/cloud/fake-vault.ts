export function fakeCredentialVaults() {
  return {
    getByName(accountId: string) {
      return {
        async fetch(input: string | Request): Promise<Response> {
          const url = new URL(typeof input === "string" ? input : input.url);
          const leaseMatch = /^\/connections\/([^/]+)\/lease$/.exec(url.pathname);
          if (leaseMatch !== null) {
            return Response.json({
              accountId,
              connectionId: decodeURIComponent(leaseMatch[1]!),
              providerAppId: "app_google",
              provider: "google",
              clientId: "client-id",
              clientSecret: "client-secret",
              refreshToken: "refresh-token",
              subject: "google-sub",
              grantedScopes: [],
            });
          }
          return Response.json({ health: "error" });
        },
      };
    },
  };
}

export function fixtureConnectionSummaries(accountId = "acct_demo") {
  return [
    {
      id: "con_personal_google",
      accountId,
      nickname: "personal-google",
      providerAppId: "app_google",
      provider: "google" as const,
      displayName: "Personal Google",
      grantedScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.labels",
        "https://www.googleapis.com/auth/documents.readonly",
      ],
      health: "healthy" as const,
    },
    {
      id: "con_work_google",
      accountId,
      nickname: "work-google",
      providerAppId: "app_google",
      provider: "google" as const,
      displayName: "Work Google",
      grantedScopes: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
      ],
      health: "healthy" as const,
    },
  ];
}
