/**
 * Teacher Mock sets: create a set, price it with the stepper, see the earning
 * line (issue 15-mock-sets-authoring).
 *
 * Definition of done, the part this screen owns: "a teacher creates a mock set
 * for an exam, sets the price with a stepper from Rs 299 to Rs 399, sees 'You
 * get about Rs X per sale'".
 *
 * The number the issue names is pinned here too: Rs 399 at a 50% share shows
 * 165.
 *
 * The browser client is a prop, so the test injects a fake: no real network
 * call and no key (web/CLAUDE.md).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TeacherMocks } from '../teacher-mocks';
import type { Exam } from '@/lib/exams/types';
import { dictionary } from '@/lib/i18n';
import type {
  BrowserMockSetsClient,
  MockSet,
  MockSetEdit,
  MockTestDraft,
} from '@/lib/mocks/types';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const TEACHER = '44444444-4444-4444-8444-444444444444';
const SET = '55555555-5555-4555-8555-555555555555';
const NET = 'a4000001-0000-4000-8000-000000000001';
const CUET = 'a4000001-0000-4000-8000-000000000002';

const en = dictionary.en;

const EXAMS: Exam[] = [
  {
    id: NET,
    code: 'ugc-net',
    nameEn: 'UGC NET',
    nameHi: 'यूजीसी नेट',
    marksCorrect: 2,
    marksWrong: 0,
    durationMin: 180,
    questionCount: 100,
    markingUnverified: false,
  },
  {
    id: CUET,
    code: 'cuet-pg',
    nameEn: 'CUET PG',
    nameHi: 'सीयूईटी पीजी',
    marksCorrect: 4,
    marksWrong: -1,
    durationMin: 105,
    questionCount: 75,
    markingUnverified: false,
  },
];

function set(over: Partial<MockSet> = {}): MockSet {
  return {
    id: SET,
    teacherId: TEACHER,
    examId: NET,
    title: 'Full length set 1',
    priceInr: 349,
    status: 'draft',
    ...over,
  };
}

function client(over: Partial<BrowserMockSetsClient> = {}): BrowserMockSetsClient {
  return {
    saveSet: vi.fn(async (edit: MockSetEdit) => set({ title: edit.title, priceInr: edit.priceInr })),
    saveTest: vi.fn(async (_setId: string, draft: MockTestDraft) => ({
      id: 'test-1',
      setId: SET,
      ...draft,
    })),
    publish: vi.fn(async () => 0),
    ...over,
  };
}

/** The price box, read by its own label. */
function priceBox(): HTMLInputElement {
  return screen.getByLabelText(en['mocks.price']) as HTMLInputElement;
}

describe('the price stepper (V11)', () => {
  it('starts at the floor, Rs 299', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={client()} />);
    expect(priceBox().value).toBe('299');
  });

  it('opens the number pad on a phone, not a keyboard', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={client()} />);
    expect(priceBox()).toHaveAttribute('inputMode', 'numeric');
    expect(priceBox()).toHaveAttribute('min', '299');
    expect(priceBox()).toHaveAttribute('max', '399');
    expect(priceBox()).toHaveAttribute('step', '10');
  });

  it('moves Rs 10 a tap, and stops at both ends', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={client()} />);

    const up = screen.getByRole('button', { name: en['mocks.priceUp'] });
    const down = screen.getByRole('button', { name: en['mocks.priceDown'] });

    fireEvent.click(up);
    expect(priceBox().value).toBe('309');

    fireEvent.click(down);
    expect(priceBox().value).toBe('299');

    // Already at the floor: another tap down changes nothing.
    fireEvent.click(down);
    expect(priceBox().value).toBe('299');

    // Ten taps up land exactly on the ceiling, and the eleventh does nothing.
    for (let i = 0; i < 11; i += 1) fireEvent.click(up);
    expect(priceBox().value).toBe('399');
  });

  it('clamps a price typed by hand back into the band', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={client()} />);

    fireEvent.change(priceBox(), { target: { value: '500' } });
    fireEvent.blur(priceBox());
    expect(priceBox().value).toBe('399');

    fireEvent.change(priceBox(), { target: { value: '10' } });
    fireEvent.blur(priceBox());
    expect(priceBox().value).toBe('299');
  });
});

describe('the earning line (X3, AS6)', () => {
  it('shows about Rs 165 for a Rs 399 set at a 50% share', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={client()} />);

    const up = screen.getByRole('button', { name: en['mocks.priceUp'] });
    for (let i = 0; i < 10; i += 1) fireEvent.click(up);

    expect(priceBox().value).toBe('399');
    const line = screen.getByTestId('earning-estimate');
    expect(line.textContent).toContain('165');
    // The word "about" is the whole point: the fee is an estimate (AS6).
    expect(line.textContent).toContain(en['mocks.earnPrefix']);
    expect(line.textContent).toContain(en['mocks.earnSuffix']);
  });

  it('follows the share, not a hard-coded half', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={70} client={client()} />);
    // 299 / 1.18 x 0.98 x 0.70 = 173.8..., so 173.
    expect(screen.getByTestId('earning-estimate').textContent).toContain('173');
  });

  it('moves with every tap of the stepper', () => {
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={client()} />);
    expect(screen.getByTestId('earning-estimate').textContent).toContain('124');

    fireEvent.click(screen.getByRole('button', { name: en['mocks.priceUp'] }));
    expect(screen.getByTestId('earning-estimate').textContent).toContain('128');
  });
});

describe('creating a set', () => {
  it('sends the exam, the trimmed name and the price, and never a status', async () => {
    const data = client();
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={data} />);

    fireEvent.change(screen.getByLabelText(en['mocks.exam']), { target: { value: CUET } });
    fireEvent.change(screen.getByLabelText(en['mocks.name']), {
      target: { value: '  Full length set 1  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: en['mocks.priceUp'] }));
    fireEvent.click(screen.getByRole('button', { name: en['mocks.create'] }));

    await waitFor(() =>
      expect(data.saveSet).toHaveBeenCalledWith({
        id: null,
        examId: CUET,
        title: 'Full length set 1',
        priceInr: 309,
      }),
    );
    await waitFor(() => expect(screen.getByText(en['mocks.saved'])).toBeInTheDocument());
  });

  it('asks for a name with no request at all', async () => {
    const data = client();
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={data} />);

    fireEvent.click(screen.getByRole('button', { name: en['mocks.create'] }));

    await waitFor(() =>
      expect(screen.getByText(en['mocks.needName'])).toBeInTheDocument(),
    );
    expect(data.saveSet).not.toHaveBeenCalled();
  });

  it('turns the duplicate CODE into one line, never a server message', async () => {
    const data = client({
      saveSet: vi.fn(async () => {
        throw new Error('duplicate');
      }),
    });
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={data} />);

    fireEvent.change(screen.getByLabelText(en['mocks.name']), {
      target: { value: 'Taken' },
    });
    fireEvent.click(screen.getByRole('button', { name: en['mocks.create'] }));

    await waitFor(() =>
      expect(screen.getByText(en['mocks.duplicate'])).toBeInTheDocument(),
    );
  });

  it('shows the generic line for anything else', async () => {
    const data = client({
      saveSet: vi.fn(async () => {
        throw new Error('Request failed with status 502');
      }),
    });
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={data} />);

    fireEvent.change(screen.getByLabelText(en['mocks.name']), {
      target: { value: 'Boom' },
    });
    fireEvent.click(screen.getByRole('button', { name: en['mocks.create'] }));

    await waitFor(() => expect(screen.getByText(en['mocks.failed'])).toBeInTheDocument());
  });

  it('adds the new set to the list with no page reload', async () => {
    const data = client();
    render(<TeacherMocks exams={EXAMS} sets={[]} sharePct={50} client={data} />);
    expect(screen.getByText(en['mocks.none'])).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(en['mocks.name']), {
      target: { value: 'Brand new' },
    });
    fireEvent.click(screen.getByRole('button', { name: en['mocks.create'] }));

    await waitFor(() => expect(screen.getByText('Brand new')).toBeInTheDocument());
  });
});

describe('the list of own sets', () => {
  it('shows the price, the status badge and a link into the set', () => {
    render(
      <TeacherMocks
        exams={EXAMS}
        sets={[set(), set({ id: NET, title: 'Live one', status: 'live', priceInr: 399 })]}
        sharePct={50}
        client={client()}
      />,
    );

    expect(screen.getByText('Full length set 1')).toBeInTheDocument();
    expect(screen.getByText(en['mocks.draft'])).toBeInTheDocument();
    expect(screen.getByText(en['mocks.live'])).toBeInTheDocument();
    // Latin digits with the rupee sign, in both languages (DESIGN.md).
    expect(screen.getByText('₹349')).toBeInTheDocument();
    expect(screen.getByText('₹399')).toBeInTheDocument();

    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', `/teacher/mocks/${SET}`);
  });

  it('says so, and shows no form, when the keys are missing', () => {
    render(
      <TeacherMocks
        exams={EXAMS}
        sets={[]}
        sharePct={50}
        client={client()}
        configured={false}
      />,
    );

    expect(screen.getByText(en['mocks.notConfigured'])).toBeInTheDocument();
    expect(screen.queryByLabelText(en['mocks.price'])).not.toBeInTheDocument();
  });
});
