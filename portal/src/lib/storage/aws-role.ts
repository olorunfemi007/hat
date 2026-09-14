import "server-only";
import { randomUUID } from "node:crypto";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { StorageError } from "./types";

/** A successful AssumeRole alone does not prove the customer's trust policy
 * requires our external ID. Only explicit authorization denials count as
 * successful negative tests; timeouts or invalid source credentials do not. */
export async function verifyAwsRoleTrust(roleArn: string, externalId: string, region: string) {
  const client = new STSClient({ region, maxAttempts: 1,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 15_000 } });
  const assume = (id?: string) => client.send(new AssumeRoleCommand({
    RoleArn: roleArn, RoleSessionName: "hardhat-connection-test", DurationSeconds: 900,
    ...(id === undefined ? {} : { ExternalId: id }),
  }), { abortSignal: AbortSignal.timeout(15_000) });
  try {
    const accepted = await assume(externalId);
    const credentials = accepted.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
      throw new StorageError("aws_role_unavailable", "AWS did not return usable role credentials. Try again.");
    }
    for (const invalidId of [undefined, `hardhat-invalid-${randomUUID()}`]) {
      let denied = false;
      try { await assume(invalidId); }
      catch (error) {
        const name = (error as { name?: string })?.name;
        if (name !== "AccessDenied" && name !== "AccessDeniedException") throw error;
        denied = true;
      }
      if (!denied) throw new StorageError("unsafe_aws_trust_policy",
        "The AWS role must reject requests with a missing or incorrect external ID. Update its trust policy and test again.", 422);
    }
    return { access_key_id: credentials.AccessKeyId, secret_access_key: credentials.SecretAccessKey,
      session_token: credentials.SessionToken };
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError("aws_role_unavailable", "Could not verify the AWS role. Check its trust policy and portal access, then try again.");
  } finally { client.destroy(); }
}
