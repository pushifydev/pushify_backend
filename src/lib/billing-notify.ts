import { organizationRepository } from '../repositories/organization.repository';
import { userRepository } from '../repositories/user.repository';

/** Billing email: org billingEmail, else organization owner account email */
export async function resolveBillingNotifyEmail(organizationId: string): Promise<string | null> {
  const org = await organizationRepository.findById(organizationId);
  if (org?.billingEmail) {
    return org.billingEmail;
  }

  const owner = await organizationRepository.findOwner(organizationId);
  if (!owner) {
    return null;
  }

  const user = await userRepository.findById(owner.userId);
  return user?.email ?? null;
}
